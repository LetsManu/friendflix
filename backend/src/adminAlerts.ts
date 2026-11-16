// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import type { DiskHealth, HealthSnapshot } from './health.js';
import { m, type Text } from './i18n.js';
import { notifyAdmins } from './notify.js';
import type { UpdaterJob } from './updater.js';
import { cachedReleaseVersion, updateInfo, type UpdateInfo } from './updates.js';

/**
 * Admin alerts (mail stage C): a new version, a failed update, a Systemcheck line turning into a problem (syscheckAlerts.ts, apart so this
 * module, which health.ts and updater.ts import, never reaches the Systemcheck engine), a disk running full. Each is an
 * admin notice (in-app for every admin) with a mail type, so the mail is the notice's channel and the notice dedupe the durable "once".
 * This module only detects the events; short kv keys (`alerts:*`) keep the frequent ticks from re-running notify() and two instances from
 * alerting twice. A failure after such a claim gives it back and rethrows, so the next run tries again.
 */
export type AlertCtx = Pick<Ctx, 'db' | 'kv' | 'cfg' | 'fetchImpl' | 'encKey'>;

const UPDATE_TICK = 'alerts:update:tick';
const UPDATE_TICK_TTL_S = 21_600;
/** a per-day claim (`alerts:<what>:…:<day>`) outlives its day */
export const DAY_CLAIM_TTL_S = 172_800;
const VERSION = /^\d+\.\d+\.\d+$/;
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

/**
 * The title of a failed job: a rollback has its own, an update names its version. The updater's tag is one only for a fixed version; the
 * stable tag `latest` names the newest release when a GitHub answer is cached (a title never costs a request), `nightly` and `sha-…` none.
 */
async function failedTitle(ctx: AlertCtx, job: UpdaterJob): Promise<Text> {
  if (job.action === 'rollback') return m('notify.update.rollbackFailed.title');
  const version = VERSION.test(job.to) ? job.to : job.to === 'latest' ? await cachedReleaseVersion(ctx) : null;
  return version ? m('notify.update.failed.title', { version }) : m('notify.update.failedPlain.title');
}

/** A finished updater job (reconcileAudit, once per job): an update, self-update or rollback that failed or was rolled back alerts. */
export async function updateFailedAlert(ctx: AlertCtx, job: UpdaterJob): Promise<number> {
  if (!UPDATE_JOBS.includes(job.action) || (job.state !== 'failed' && job.state !== 'rolled_back')) return 0;
  return notifyAdmins(ctx, {
    kind: 'update_failed', title: await failedTitle(ctx, job), body: m('notify.update.failed.body'),
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

/** free space as the notice says it: whole GB (10^9 bytes, like the recordings storage notice), under 1 GB whole MB */
const freeText = (bytes: number) => (bytes < 1_000_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${Math.round(bytes / 1_000_000_000)} GB`);

/**
 * After each health snapshot (healthTick, every 60 s): the downloads and previews disks at warn or err because they are full or short of
 * free space (not the download cap, not the database's size) alert once per disk, level and server-local day; err after warn on the same
 * day alerts again, warn after err (a little freed) does not. Returns the disks alerted in this call.
 */
export async function diskAlerts(ctx: AlertCtx, snap: HealthSnapshot, now: Date = new Date()): Promise<Array<DiskHealth['id']>> {
  const out: Array<DiskHealth['id']> = [];
  const day = dayKey(now);
  for (const d of snap.disks) {
    const id = d.id;
    if (!alertDisk(id) || !fillingUp(d) || d.usedPct === undefined) continue;
    const claim = `alerts:disk:${id}:${d.level}:${day}`;
    if (!(await ctx.kv.setnx(claim, '1', DAY_CLAIM_TTL_S))) continue;
    // "full" covers "almost full" for the rest of the day (taken only when free: an earlier warn claim is left alone)
    const warnKey = `alerts:disk:${id}:warn:${day}`;
    const claims = [claim];
    try {
      if (d.level === 'err' && (await ctx.kv.setnx(warnKey, '1', DAY_CLAIM_TTL_S))) claims.push(warnKey);
      await notifyAdmins(ctx, {
        kind: 'disk_low', title: m(d.level === 'err' ? 'notify.disk.full.title' : 'notify.disk.almostFull.title', { disk: m(`notify.disk.${id}`), pct: d.usedPct }),
        body: d.freeBytes !== undefined ? m('notify.disk.free.body', { free: freeText(d.freeBytes) }) : null,
        link: '/admin/status', dedupe: `disk-${id}-${d.level}-${day}`, mail: 'storage',
      });
    } catch (e) {
      await Promise.all(claims.map((k) => ctx.kv.del(k).catch(() => undefined)));
      throw e;
    }
    out.push(id);
  }
  return out;
}
