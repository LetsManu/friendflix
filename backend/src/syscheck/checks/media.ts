// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { bounded, type ServiceHealth } from '../../health.js';
import { pinDiffKey, differingPin } from '../../mediaserver/pinTick.js';
import { mediaView, type MediaView } from '../../routes/adminMediaserver.js';
import { runProbe } from '../../settings/probes.js';
import { MEDIA_JOB_ACTIONS, updaterView, type UpdaterJob, type UpdaterView } from '../../updater.js';
import type { CheckEnv, GroupCheck } from '../engine.js';
import { bad, line } from '../line.js';
import { CHECK_TIMEOUT_MS, type CheckId, type CheckLine } from '../types.js';
import { levelToStatus, msOf, service, timedLine } from './util.js';

/**
 * Medien: the media server, the request service, the TMDB/OMDb keys, the nightly playback check and the transcoding advice, from the health
 * snapshot. Only a request service that reads as down is probed again (to tell a refused key from an unreachable service).
 */
/** what the request-service re-probe leaves for the rest of the group, and the least worth starting a probe for */
const REPROBE_SPARE_MS = 300;
const REPROBE_MIN_MS = 300;

function serverLine(env: CheckEnv, h: ServiceHealth | undefined): CheckLine {
  return timedLine('media.server', h, 'media', { settingKey: env.ctx.cfg.MEDIA_SERVER === 'plex' ? 'PLEX_URL' : 'JELLYFIN_URL' });
}

const MANAGED_HREF = '/admin/settings?tab=media';
const MANAGED_DOCS = 'mediaserver.md';
/** the updater's status read is bounded at 5 s (updater.ts); this line waits for it no longer than the updates group does */
const MANAGED_MS = 2_500;
const DAY_MS = 86_400_000;
const UPDATE_PENDING_MS = 7 * DAY_MS;
const BACKUP_OLD_MS = 30 * DAY_MS;
const MEDIA_ACTIONS: readonly string[] = MEDIA_JOB_ACTIONS;
const olderThan = (iso: string, ms: number) => { const t = Date.parse(iso); return Number.isFinite(t) && Date.now() - t > ms; };

/** the error code of the updater's last job when it is a media job that failed, or an update whose media phase failed; else null */
function failedMediaJob(j: UpdaterJob | null): string | null {
  if (!j) return null;
  const failed = (MEDIA_ACTIONS.includes(j.action) && (j.state === 'failed' || j.state === 'rolled_back')) || (j.action === 'update' && j.state === 'succeeded_mediaserver_failed');
  return failed ? j.error ?? 'unexpected' : null;
}

/**
 * The managed media server (spec "Systemcheck", first match wins): neutral while an external server is in use, then what keeps it
 * from working (updater, engine, proxy, a tampered or stopped container, its health, the base folder, folders, GPU), then what needs
 * an admin soon (the last media job failed, a pending update older than 7 days, no backup in 30 days). Codes and the kind and
 * version only: never the base path, a folder, a pin or a backup id.
 */
export async function managedLine(env: CheckEnv, view: MediaView | null, updater: UpdaterView): Promise<CheckLine> {
  const id = 'media.managed';
  const o = { href: MANAGED_HREF, docs: MANAGED_DOCS };
  if (!view) return line(id, 'unknown', { cause: 'check_unavailable', ...o });
  const managedKind = view.managed.kind;
  const s = 'status' in updater ? updater.status.mediaserver : null;
  const c = s?.container ?? null;
  if (view.mode === 'external' && !c) return bad(id, 'not_set_up', 'managed_off', o);
  if (!s) return managedKind ? bad(id, 'warning', 'managed_no_updater', o) : bad(id, 'not_set_up', 'managed_off', o);
  // the updater has not read the media status yet since it started (a pin verify can take minutes): pending, never a warning
  if (s.reason === 'starting') return bad(id, 'not_set_up', 'managed_starting', o);
  if (s.reason === 'engine_old') return c ? bad(id, 'problem', 'managed_engine_old', o) : bad(id, 'not_set_up', 'managed_engine_old', o);
  if (s.reason === 'no_logs') return bad(id, 'warning', 'managed_proxy_outdated', { ...o, docs: 'mediaserver.md#update-the-compose-files' });
  // any other reason the updater cannot run the media server (no project, no media network, its engine unreachable): like no updater
  if (!s.available) return managedKind ? bad(id, 'warning', 'managed_no_updater', o) : bad(id, 'not_set_up', 'managed_off', o);
  if (c?.tampered) return bad(id, 'problem', 'managed_tampered', o);
  if (s.desired?.run && c?.state !== 'running') return bad(id, 'problem', 'managed_down', o);
  if (c?.health === 'unhealthy') return bad(id, 'problem', 'managed_unhealthy', o);
  if (s.error === 'base_missing') return bad(id, 'problem', 'managed_base_missing', o);
  if (s.error === 'folder_missing') return bad(id, 'warning', 'managed_folder_missing', o);
  if (s.error === 'gpu_missing' || s.error === 'nvidia_missing') return bad(id, 'warning', 'managed_gpu_missing', o);
  const code = failedMediaJob('status' in updater ? updater.status.job : null);
  if (code) return bad(id, 'warning', 'managed_job_failed', { ...o, params: { code } });
  const pin = differingPin(s);
  const seen = pin ? await env.ctx.kv.get(pinDiffKey(pin)) : null;
  if (seen && olderThan(seen, UPDATE_PENDING_MS)) return bad(id, 'warning', 'managed_update_pending', o);
  const newest = s.backups.reduce<string | null>((a, b) => (a === null || Date.parse(b.at) > Date.parse(a) ? b.at : a), null);
  if (newest ? olderThan(newest, BACKUP_OLD_MS) : c !== null && olderThan(c.createdAt, BACKUP_OLD_MS)) return bad(id, 'warning', 'managed_backup_old', o);
  return line(id, 'ok', { ...o, params: { kind: c?.kind ?? managedKind ?? undefined, upstream: c?.image.upstream } });
}

/**
 * the managed line from one updater status read (the page's view reuses it); an input that does not come in time (a stalled database)
 * is unknown / check_unavailable for this line alone, a throw check_failed
 */
async function managedLineOf(env: CheckEnv): Promise<CheckLine> {
  const r = await bounded(async () => {
    const u = await updaterView(env.ctx);
    return managedLine(env, await mediaView(env.ctx, u), u);
  }, MANAGED_MS);
  return r.ok ? r.v : line('media.managed', 'unknown', { cause: r.timeout ? 'check_unavailable' : 'check_failed', href: MANAGED_HREF, docs: MANAGED_DOCS });
}

/** `left`: the group's time still available when the line is read (the re-probe never takes the other lines down with it) */
async function requestsLine(env: CheckEnv, h: ServiceHealth | undefined, left: number): Promise<CheckLine> {
  const id = 'media.requests';
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok', msOf(h));
  if (status === 'not_set_up') return bad(id, status, 'requests_not_set', { settingKey: 'REQUESTS_URL' });
  if (status === 'unknown') return bad(id, status, 'check_unavailable');
  // down (only ever a warning: wishes stop, nothing else): a refused key is a different fix than an unreachable service, asked again
  // within what is left of the group's limit; no time left, or no answer, keeps the snapshot's verdict
  const down = bad(id, 'warning', 'requests_down', { ...msOf(h), settingKey: 'REQUESTS_URL' });
  const budget = Math.min(left - REPROBE_SPARE_MS, env.timeoutMs - 1_000);
  if (budget < REPROBE_MIN_MS) return down;
  const r = await runProbe(env.ctx, 'requests', env.ctx.cfg, { timeoutMs: budget });
  if (r.ok) return line(id, 'ok');
  return r.code === 'unauthorized' ? bad(id, 'warning', 'requests_key_invalid', { settingKey: 'REQUESTS_API_KEY' }) : down;
}

function sourceLine(id: CheckId, h: ServiceHealth | undefined, settingKey: 'TMDB_API_KEY' | 'OMDB_API_KEY'): CheckLine {
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok');
  if (status === 'not_set_up') return bad(id, status, 'source_not_set', { settingKey });
  switch (h.reason) {
    case 'invalid_key': return bad(id, status, 'source_key_invalid', { settingKey });
    case 'paused': return bad(id, status, 'source_paused');
    case 'budget': return bad(id, status, 'source_budget', { params: { pct: h.detail?.pct, n: h.detail?.n } });
    default: return bad(id, 'unknown', 'check_unavailable');
  }
}

function playbackLine(h: ServiceHealth | undefined): CheckLine {
  const id = 'media.playback';
  const href = '/admin/playback';
  if (!h) return bad(id, 'unknown', 'check_unavailable', { href });
  if (h.level === 'off') return bad(id, 'unknown', h.reason === 'unavailable' ? 'check_unavailable' : 'playback_never', { href });
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok');
  // every title failed: the media server, not a file, is broken
  return bad(id, status, h.reason === 'empty_media' ? 'playback_empty' : 'playback_failed', { params: { n: h.detail?.n }, href });
}

function encoderLine(h: ServiceHealth | undefined): CheckLine {
  const id = 'media.encoder';
  // a media server without readable transcoding settings (Plex) has no row: neutral, never red
  if (!h) return bad(id, 'not_set_up', 'encoder_unsupported');
  const hevc = h.hevc ? { hevc: h.hevc.state, speed: h.hevc.speed } : {};
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok', { params: hevc });
  if (status !== 'warning' || !h.advice?.length) return bad(id, 'unknown', 'check_unavailable');
  // advice only, most important first: the first is the cause, all of them go to the UI as codes
  const cause = h.advice[0]!;
  return bad(id, status, cause, { params: { advice: h.advice.join(','), ...hevc }, ...(cause.startsWith('hevc_') ? { settingKey: 'HEVC_STREAMS' } : {}) });
}

export const mediaCheck: GroupCheck = {
  group: 'media',
  ids: ['media.server', 'media.managed', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder'],
  timeoutMs: CHECK_TIMEOUT_MS,
  async run(env) {
    const t0 = performance.now();
    // the managed line reads the updater and the database, not the snapshot: started at once, alongside
    const managed = managedLineOf(env);
    const s = await env.snapshot();
    // no snapshot within its limit: nothing else here can be read this time
    if (!s) return [await managed, ...mediaCheck.ids.filter((id) => id !== 'media.managed').map((id) => bad(id, 'unknown', 'check_unavailable'))];
    const [managedL, requestsL] = await Promise.all([managed, requestsLine(env, service(s, 'requests'), env.timeoutMs - (performance.now() - t0))]);
    return [
      serverLine(env, service(s, 'media')),
      managedL,
      requestsL,
      sourceLine('media.tmdb', service(s, 'tmdb'), 'TMDB_API_KEY'),
      sourceLine('media.omdb', service(s, 'omdb'), 'OMDB_API_KEY'),
      playbackLine(service(s, 'playbackCheck')),
      encoderLine(service(s, 'encoder')),
    ];
  },
};
