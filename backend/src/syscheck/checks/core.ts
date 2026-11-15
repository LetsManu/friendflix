// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { probeQuery } from '../../db.js';
import { bounded, removedEnvCount, type DiskHealth, type HealthSnapshot, type ServiceHealth } from '../../health.js';
import { runProbe } from '../../settings/probes.js';
import type { CheckEnv, GroupCheck } from '../engine.js';
import { bad, line } from '../line.js';
import { CHECK_TIMEOUT_MS, type CheckId, type CheckLine } from '../types.js';
import { levelToStatus, service, timedLine } from './util.js';

export { levelToStatus } from './util.js';

/**
 * Grundlagen: the public URL (the setup probe), the database, Redis and the gateway, the disks and old variable names, all from the health
 * snapshot except the public URL. A line uses the snapshot's own level, so the banner and the Systemcheck never disagree. Whether Redis
 * keeps the sign-ins across a restart is read from Redis itself (INFO persistence, never CONFIG).
 */
const GiB = 1024 ** 3;

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

/** `shared`: this line is read from the other volume's entry; `partner`: the entry also covers that volume (both say so in params) */
function diskLine(id: DiskId, d: DiskHealth | undefined, shared?: 'downloads' | 'previews', partner?: 'downloads' | 'previews'): CheckLine {
  const lid = DISK_LINE[id];
  if (!d) return bad(lid, 'unknown', 'disk_unreadable');
  const other = shared ?? partner;
  const extra = other ? { sharedWith: other } : {};
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
    ? diskLine('downloads', dl, undefined, dl?.sharedWith)
    : bad('core.disk.downloads', 'not_set_up', 'downloads_off', { settingKey: 'DOWNLOADS_ENABLED' });
  // one filesystem for both volumes: the snapshot has one entry (downloads, sharedWith previews), the Systemcheck both lines
  const previews = dl?.sharedWith === 'previews' && env.ctx.cfg.DOWNLOADS_ENABLED === 'true' ? diskLine('previews', dl, 'downloads') : diskLine('previews', disk('previews'));
  return [downloads, previews, diskLine('database', disk('database'))];
}

function envLine(): CheckLine {
  const n = removedEnvCount(process.env);
  return n > 0 ? bad('core.env', 'warning', 'removed_env', { params: { n }, docs: 'operations.md' }) : line('core.env', 'ok');
}

/** the operations guide's section on the redis-data volume (the compose lines an older install still has to apply) */
export const REDIS_PERSIST_DOCS = 'operations.md#redis-volume-redis-data';

/**
 * Redis writes its append-only file (compose: --appendonly yes on the redis-data volume): sign-ins survive a restart and a reboot.
 * Without it (a compose file or a Portainer stack from before, an own override) every reboot signs everybody out: a warning that
 * names the compose lines. On, but its last write failed (disk full, volume not writable): a warning too (Redis refuses writes
 * meanwhile), never ok. Not readable (Redis down, a store without INFO): not checked, the core.redis line says why.
 */
async function redisPersistLine(env: CheckEnv): Promise<CheckLine> {
  const id = 'core.redisPersistence';
  const o = await bounded(() => env.ctx.kv.aofStatus(), FALLBACK_MS);
  if (!o.ok || !o.v) return bad(id, 'unknown', 'check_unavailable');
  if (o.v === 'ok') return line(id, 'ok');
  return bad(id, 'warning', o.v === 'off' ? 'redis_not_persistent' : 'redis_aof_write_failed', { docs: REDIS_PERSIST_DOCS });
}

/** a dependency read directly when the snapshot did not come in time (a stalled database holds the snapshot, not this probe) */
const FALLBACK_MS = 500;
async function ownProbe(id: 'postgres' | 'redis', fn: () => Promise<unknown>): Promise<ServiceHealth> {
  const o = await bounded(async () => Boolean(await fn()), FALLBACK_MS);
  return o.ok && o.v ? { id, level: 'ok', ms: o.ms } : { id, level: 'err', reason: 'down', ms: o.ms };
}

export const coreCheck: GroupCheck = {
  group: 'core',
  ids: ['core.publicUrl', 'core.database', 'core.redis', 'core.redisPersistence', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env'],
  timeoutMs: CHECK_TIMEOUT_MS,
  async run(env) {
    // the direct probes start with the snapshot wait, not after it: when the snapshot misses its limit they have long answered, so the
    // group keeps its margin to the limit (two cheap reads per run; unused when the snapshot comes)
    const fallback = Promise.all([ownProbe('postgres', async () => (await probeQuery(env.ctx.db, 'select 1', [], FALLBACK_MS), true)), ownProbe('redis', () => env.ctx.kv.ping())]);
    const persist = redisPersistLine(env);
    const [pub, s] = await Promise.all([publicUrlLine(env), env.snapshot()]);
    if (!s) {
      // no snapshot within its limit: the database and Redis answer from their direct probes, the rest is not known this time
      const [db, redis] = await fallback;
      const unknown = (id: CheckId) => bad(id, 'unknown', 'check_unavailable');
      return [
        pub,
        timedLine('core.database', db, 'db', { docs: 'operations.md' }),
        timedLine('core.redis', redis, 'redis'),
        await persist,
        unknown('core.gateway'), unknown('core.disk.downloads'), unknown('core.disk.previews'), unknown('core.disk.database'),
        envLine(),
      ];
    }
    return [
      pub,
      timedLine('core.database', service(s, 'postgres'), 'db', { docs: 'operations.md' }),
      timedLine('core.redis', service(s, 'redis'), 'redis'),
      await persist,
      timedLine('core.gateway', service(s, 'gateway'), 'gateway'),
      ...diskLines(env, s),
      envLine(),
    ];
  },
};
