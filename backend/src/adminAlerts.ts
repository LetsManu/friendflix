// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import type { DiskHealth, HealthSnapshot } from './health.js';
import { m } from './i18n.js';
import { notifyAdmins } from './notify.js';
import { getSystemcheck } from './syscheck/engine.js';
import { CHECK_GROUPS, type CheckId } from './syscheck/types.js';
import type { UpdaterJob } from './updater.js';
import { updateInfo, type UpdateInfo } from './updates.js';

/**
 * Admin alerts (mail stage C): a new version, a failed update, a Systemcheck line turning into a problem, a disk running full. Each is an
 * admin notice (in-app for every admin) with a mail type, so the mail is the notice's channel and the notice dedupe the durable "once".
 * This module only detects the events; short kv keys (`alerts:*`) keep the frequent ticks from re-running notify() and two instances from
 * alerting twice. A failure after such a claim gives it back and rethrows, so the next run tries again.
 */
export type AlertCtx = Pick<Ctx, 'db' | 'kv' | 'cfg' | 'fetchImpl' | 'encKey'>;

const UPDATE_TICK = 'alerts:update:tick';
const UPDATE_TICK_TTL_S = 21_600;
const SYSCHECK_TICK = 'alerts:syscheck:tick';
const SYSCHECK_TICK_TTL_S = 840;
const SYSCHECK_PREV = 'alerts:syscheck:prev';
const SYSCHECK_PREV_TTL_S = 86_400;
const DAY_CLAIM_TTL_S = 172_800;
/** the updater jobs whose failure is an alert (livetv enable / disable / remove are not) */
const UPDATE_JOBS: ReadonlyArray<UpdaterJob['action']> = ['update', 'self-update', 'rollback'];
/** the FriendFlix volumes that fill up (the database only grows large, which is advice, not an alert) */
const alertDisk = (id: DiskHealth['id']): id is 'downloads' | 'previews' => id === 'downloads' || id === 'previews';
/** full or short of free space (not the download cap) */
const fillingUp = (d: DiskHealth): boolean => (d.level === 'warn' || d.level === 'err') && (d.reason === 'full' || d.reason === 'low_free');

const pad = (n: number) => String(n).padStart(2, '0');
/** the server's calendar day of `d`, yyyy-mm-dd (like digest.ts weekKey) */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** the ISO week of the server-local date of `d`, e.g. 2026-W47 (the week's Thursday decides the year) */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

/** what is new on the selected channel: the dedupe target and the version the title names; null when nothing is */
function available(i: UpdateInfo, now: Date): { channel: string; target: string; version: string } | null {
  if (i.updateAvailable !== true) return null;
  const channel = i.channel.selected;
  if (channel === 'nightly') {
    // a nightly build appears almost daily: at most one alert a week
    const sha = i.latest?.sha;
    return sha ? { channel, target: isoWeek(now), version: `nightly · ${sha.slice(0, 7)}` } : null;
  }
  const v = channel === 'pinned' ? i.channel.version : i.release?.version;
  return v ? { channel, target: v, version: v } : null;
}

/**
 * Hourly timer; the check runs at most every 6 h across instances. Nothing while the nightly window installs updates through the updater
 * (a failure there alerts on its own). Returns how many admins were notified.
 */
export async function updateAlertTick(ctx: Ctx, now: Date = new Date()): Promise<number> {
  if (ctx.cfg.AUTO_UPDATE === 'nightly-window' && ctx.cfg.UPDATER_URL) return 0;
  if (!(await ctx.kv.setnx(UPDATE_TICK, '1', UPDATE_TICK_TTL_S))) return 0;
  try {
    const a = available(await updateInfo(ctx), now);
    if (!a) return 0;
    return await notifyAdmins(ctx, {
      kind: 'update_available', title: m('notify.update.available.title', { version: a.version }), body: m('notify.update.available.body'),
      link: '/admin/update', dedupe: `update-avail-${a.channel}-${a.target}`, mail: 'update',
    });
  } catch (e) {
    await ctx.kv.del(UPDATE_TICK).catch(() => undefined);
    throw e;
  }
}

/** A finished updater job (reconcileAudit, once per job): an update, self-update or rollback that failed or was rolled back alerts. */
export async function updateFailedAlert(ctx: AlertCtx, job: UpdaterJob): Promise<number> {
  if (!UPDATE_JOBS.includes(job.action) || (job.state !== 'failed' && job.state !== 'rolled_back')) return 0;
  return notifyAdmins(ctx, {
    kind: 'update_failed', title: m('notify.update.failed.title', { version: job.to }), body: m('notify.update.failed.body'),
    link: '/admin/update', dedupe: `update-failed-${job.id}`, mail: 'updatefailed',
  });
}

/** The automatic redeploy through Portainer failed (autoUpdateTick): once per target and server-local day. */
export async function portainerFailedAlert(ctx: AlertCtx, target: string, now: Date = new Date()): Promise<number> {
  return notifyAdmins(ctx, {
    kind: 'update_failed', title: m('notify.update.portainerFailed.title'), body: m('notify.update.failed.body'),
    link: '/admin/update', dedupe: `update-failed-portainer-${target}-${dayKey(now)}`, mail: 'updatefailed',
  });
}

async function previousProblems(ctx: AlertCtx): Promise<Set<string>> {
  try {
    const v = JSON.parse((await ctx.kv.get(SYSCHECK_PREV)) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * 15-minute timer, one instance per run. A server line *turns* problem when it is one now and was not in the previous run; each line
 * alerts at most once per server-local day (a flapping line), a problem that stays never repeats, and all lines turning in one run make
 * one notice naming their groups (an outage flips several at once). Returns the lines alerted in this run.
 */
export async function syscheckAlertTick(ctx: Ctx, now: Date = new Date()): Promise<CheckId[]> {
  if (!(await ctx.kv.setnx(SYSCHECK_TICK, '1', SYSCHECK_TICK_TTL_S))) return [];
  const claimed: string[] = [];
  try {
    const result = await getSystemcheck(ctx);
    const problems = result.lines.filter((l) => l.runs === 'server' && l.status === 'problem');
    const prev = await previousProblems(ctx);
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
    await ctx.kv.set(SYSCHECK_PREV, JSON.stringify(problems.map((l) => l.id)), SYSCHECK_PREV_TTL_S);
    return turned.map((l) => l.id);
  } catch (e) {
    await Promise.all([SYSCHECK_TICK, ...claimed].map((k) => ctx.kv.del(k).catch(() => undefined)));
    throw e;
  }
}

/** free space as the notice says it: whole GB (10^9 bytes, like the recordings storage notice) */
const freeText = (bytes: number) => `${Math.round(bytes / 1_000_000_000)} GB`;

/**
 * After each health snapshot (healthTick, every 60 s): the downloads and previews disks at warn or err because they are full or short of
 * free space (not the download cap, not the database's size) alert once per disk, level and server-local day; err after warn on the same
 * day alerts again. Returns the disks alerted in this call.
 */
export async function diskAlerts(ctx: AlertCtx, snap: HealthSnapshot, now: Date = new Date()): Promise<Array<DiskHealth['id']>> {
  const out: Array<DiskHealth['id']> = [];
  const day = dayKey(now);
  for (const d of snap.disks) {
    const id = d.id;
    if (!alertDisk(id) || !fillingUp(d) || d.usedPct === undefined) continue;
    const claim = `alerts:disk:${d.id}:${d.level}:${day}`;
    if (!(await ctx.kv.setnx(claim, '1', DAY_CLAIM_TTL_S))) continue;
    try {
      await notifyAdmins(ctx, {
        kind: 'disk_low', title: m(d.level === 'err' ? 'notify.disk.full.title' : 'notify.disk.almostFull.title', { disk: m(`notify.disk.${id}`), pct: d.usedPct }),
        body: d.freeBytes !== undefined ? m('notify.disk.free.body', { free: freeText(d.freeBytes) }) : null,
        link: '/admin/status', dedupe: `disk-${d.id}-${d.level}-${day}`, mail: 'storage',
      });
    } catch (e) {
      await ctx.kv.del(claim).catch(() => undefined);
      throw e;
    }
    out.push(id);
  }
  return out;
}
