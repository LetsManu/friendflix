// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { removedEnvCount, type DiskHealth, type HealthSnapshot, type Level, type Reason, type ServiceHealth, type ServiceId } from '../../health.js';
import { runProbe } from '../../settings/probes.js';
import type { CheckEnv, GroupCheck } from '../engine.js';
import { bad, line, type LineOpts } from '../line.js';
import { CHECK_TIMEOUT_MS, type CheckId, type CheckLine, type CheckStatus } from '../types.js';

/**
 * Grundlagen: the public URL (the setup probe), the database, Redis and the gateway, the disks and old variable names, all from the health
 * snapshot except the public URL. A line uses the snapshot's own level, so the banner and the Systemcheck never disagree.
 */
const GiB = 1024 ** 3;

/** the snapshot level as a line status (spec "Status rules"); `off` is not set up only when the reason says so */
export function levelToStatus(level: Level, reason?: Reason): CheckStatus {
  switch (level) {
    case 'err': return 'problem';
    case 'warn': return 'warning';
    case 'ok': return 'ok';
    default: return reason === 'not_set' ? 'not_set_up' : 'unknown';
  }
}

export const service = (s: HealthSnapshot, id: ServiceId): ServiceHealth | undefined => s.services.find((x) => x.id === id);
const msOf = (h: ServiceHealth) => (h.ms !== undefined ? { ms: h.ms } : {});

/** a timed service row (database, Redis, gateway): down → problem, slow → warning, with the cause prefix of the line */
function timedLine(id: CheckId, h: ServiceHealth | undefined, prefix: string, o: LineOpts = {}): CheckLine {
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok', msOf(h));
  if (status === 'problem') return bad(id, status, `${prefix}_down`, { ...msOf(h), ...o });
  if (status === 'warning') return bad(id, status, `${prefix}_slow`, { ...msOf(h), ...o });
  return bad(id, 'unknown', 'check_unavailable');
}

async function publicUrlLine(env: CheckEnv): Promise<CheckLine> {
  const id = 'core.publicUrl';
  const r = await runProbe(env.ctx, 'publicUrl', env.ctx.cfg, { timeoutMs: Math.max(500, env.timeoutMs - 1_000) });
  const o = { settingKey: 'PUBLIC_URL' };
  if (!r.ok) return bad(id, 'problem', 'public_url_invalid', o);
  if (r.code !== 'warning') return line(id, 'ok');
  // http: cookies are not secure, cast and passkeys are off; any other warning: the URL did not reach this backend (often NAT loopback)
  return bad(id, 'warning', r.detail === 'insecure' ? 'public_url_http' : 'public_url_echo', o);
}

type DiskId = 'downloads' | 'previews' | 'database';
const DISK_LINE: Record<DiskId, CheckId> = { downloads: 'core.disk.downloads', previews: 'core.disk.previews', database: 'core.disk.database' };

function diskLine(id: DiskId, d: DiskHealth | undefined, shared?: 'downloads' | 'previews'): CheckLine {
  const lid = DISK_LINE[id];
  if (!d) return bad(lid, 'unknown', 'disk_unreadable');
  const extra = shared ? { sharedWith: shared } : {};
  // the cache limit is the downloads' own bytes: on a shared filesystem it says nothing about the previews
  const status = shared && d.reason === 'cap' ? 'ok' : levelToStatus(d.level, d.reason);
  if (status === 'ok') return line(lid, 'ok', { params: extra });
  if (status === 'unknown' || status === 'not_set_up') return bad(lid, 'unknown', 'disk_unreadable');
  switch (d.reason) {
    case 'full': return bad(lid, status, 'disk_full', { params: { pct: d.usedPct, ...extra }, settingKey: 'HEALTH_DISK_WARN_PCT' });
    case 'low_free': return bad(lid, status, 'disk_low_free', { params: { n: Math.floor((d.freeBytes ?? 0) / GiB), ...extra }, settingKey: 'DOWNLOAD_MIN_FREE_GB' });
    case 'cap': return bad(lid, status, 'disk_cap', { params: { pct: d.capBytes ? Math.round((d.ownBytes / d.capBytes) * 100) : undefined, ...extra }, settingKey: 'DOWNLOAD_CACHE_MAX_GB' });
    case 'large': return bad(lid, status, 'db_large', { params: { n: Math.round(d.ownBytes / GiB) }, settingKey: 'HEALTH_DB_WARN_GB' });
    default: return bad(lid, 'unknown', 'disk_unreadable');
  }
}

function diskLines(env: CheckEnv, s: HealthSnapshot): CheckLine[] {
  const disk = (id: DiskId) => s.disks.find((d) => d.id === id);
  const dl = disk('downloads');
  const downloads = env.ctx.cfg.DOWNLOADS_ENABLED === 'true'
    ? diskLine('downloads', dl)
    : bad('core.disk.downloads', 'not_set_up', 'downloads_off', { settingKey: 'DOWNLOADS_ENABLED' });
  // one filesystem for both volumes: the snapshot has one entry (downloads, sharedWith previews), the Systemcheck both lines
  const previews = dl?.sharedWith === 'previews' && env.ctx.cfg.DOWNLOADS_ENABLED === 'true' ? diskLine('previews', dl, 'downloads') : diskLine('previews', disk('previews'));
  return [downloads, previews, diskLine('database', disk('database'))];
}

function envLine(): CheckLine {
  const n = removedEnvCount(process.env);
  return n > 0 ? bad('core.env', 'warning', 'removed_env', { params: { n }, docs: 'operations.md' }) : line('core.env', 'ok');
}

export const coreCheck: GroupCheck = {
  group: 'core',
  ids: ['core.publicUrl', 'core.database', 'core.redis', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env'],
  timeoutMs: CHECK_TIMEOUT_MS,
  async run(env) {
    const [pub, s] = await Promise.all([publicUrlLine(env), env.snapshot()]);
    return [
      pub,
      timedLine('core.database', service(s, 'postgres'), 'db', { docs: 'operations.md' }),
      timedLine('core.redis', service(s, 'redis'), 'redis'),
      timedLine('core.gateway', service(s, 'gateway'), 'gateway'),
      ...diskLines(env, s),
      envLine(),
    ];
  },
};
