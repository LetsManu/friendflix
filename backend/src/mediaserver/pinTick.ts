// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { updaterView, type TickLog } from '../updater.js';
import { startMediaJob, type MediaStatus } from './client.js';
import { readManaged } from './store.js';

/**
 * The managed media server follows the FriendFlix build (spec "Images and updates"): an update the updater ran moves it in the
 * update job's own media phase; for a build the updater did not install (Portainer, `compose pull` by hand) the updater reports
 * `pin.changed` and this tick (BACKGROUND_JOBS=true, every 60 s while operational) starts the same media update at once. The updater
 * records the build it read the pins from on every attempt, so a start is sent once per build change (a refused one is tried again).
 * Never while the first run owns the server (setup not done, or failed), never for a server the admin stopped (desired.run false).
 * The same status read audits the supervisor's recreate of a missing container (`mediaserver.recover`, once per job) and notes when a
 * pin that differs from the running image was first seen (the Systemcheck's managed_update_pending).
 */

const DAY_S = 86_400;
const PIN_DIFF_TTL_S = 30 * DAY_S;
const recoverKey = (jobId: string) => `media:recover:${jobId}`;
export const pinDiffKey = (pinImage: string) => `media:pindiff:${pinImage}`;
const warnKey = (code: string) => `media:pintick:warn:${code}`;

/** the pin image when it differs from the image the container runs (null when either is unknown or they are the same) */
export function differingPin(s: MediaStatus): string | null {
  const image = s.pin?.image, digest = s.container?.image.digest;
  return image && digest && !image.endsWith(`@${digest}`) ? image : null;
}

/** `off`: no updater, or one from before the media server; `idle`: nothing to start; `busy`: a job runs; `started`: an update was started */
export async function mediaPinTick(ctx: Ctx, log?: TickLog): Promise<'off' | 'idle' | 'started' | 'busy'> {
  if (!ctx.cfg.UPDATER_URL) return 'off';
  const view = await updaterView(ctx);
  if (!('status' in view) || !view.status.mediaserver) return 'off';
  const { job, busy, mediaserver: s } = view.status;

  if (job?.action === 'mediaserver-recover' && (await ctx.kv.setnx(recoverKey(job.id), '1', 7 * DAY_S))) {
    await audit(ctx, null, 'mediaserver.recover');
  }
  const pin = differingPin(s);
  if (pin) {
    // the first-seen time stays while the difference lasts: its ttl is renewed on every read (else after 30 days it would be
    // recorded anew and hide managed_update_pending for another 7)
    const key = pinDiffKey(pin);
    if (!(await ctx.kv.setnx(key, new Date().toISOString(), PIN_DIFF_TTL_S))) {
      const first = await ctx.kv.get(key);
      if (first) await ctx.kv.replace(key, first, PIN_DIFF_TTL_S);
    }
  }

  if (!s.pin?.changed || s.desired?.run !== true || !s.container) return 'idle';
  if (busy) return 'busy';
  // the first run owns the server until its setup is done (an apply also reads as a changed build until finish-setup ran)
  const m = await readManaged(ctx.db);
  if (!m.kind || m.setup !== 'done' || m.setupError !== null) return 'idle';
  const r = await startMediaJob(ctx, { op: 'update' }, null, { op: 'update', auto: true });
  if (r.ok) return 'started';
  if (r.error === 'busy') return 'busy';
  // refused (no base, an outdated updater, …): tried again next tick; told at most once an hour per code
  if (r.error !== 'not_available' && (await ctx.kv.setnx(warnKey(r.error), '1', 3_600).catch(() => false))) {
    log?.warn({ code: r.error }, 'automatic media server update could not start');
  }
  return 'idle';
}
