// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from './app.js';
import { watchUntrustedHost } from './netaddr.js';
import { loadConfig, removedEnvNames } from './config.js';
import { keyFromBase64 } from './crypto.js';
import { migrate } from './db.js';
import { createMediaServer, mediaConfigProblems } from './media/index.js';
import { dispatchMediaEvent } from './media/events.js';
import { RedisKV } from './kv.js';
import { authentikConfigProblem } from './invites.js';
import { createLazyOidc } from './oidc.js';
import { SeerrClient } from './seerr/client.js';
import { syncRoles } from './rolecat.js';
import { loadRoles } from './roles.js';
import { nightlyTick } from './healthcheck.js';
import { convBenchTick } from './convbench.js';
import { detectLivetv, livetvDetectTick, livetvInstalled } from './livetv/detect.js';
import { livetvEpgPruneTick } from './livetv/epg.js';
import { livetvIngestTick } from './livetv/ownfeeds.js';
import { livetvRefreshTick } from './livetv/refresh.js';
import { livetvTick } from './livetv/streams.js';
import { hevcTick } from './hevcenc.js';
import { digestTick } from './digest.js';
import { expiryTick } from './expiry.js';
import { deletionTick } from './deletion.js';
import { reapplyPoliciesOnce } from './users.js';
import { pushEnabled } from './push.js';
import { previewWarmTick } from './previews.js';
import { gcDownloads, startPreparerTick } from './downloadprep.js';
import { gcLicenses } from './downloads.js';
import { pollJellyfinSessions } from './routes/internal.js';
import { parties } from './routes/party.js';
import { calendarNotifications, pollTick } from './routes/polls.js';
import { resolveRequestedPolls } from './polls.js';
import { reminderTick } from './reminders.js';
import { leavingTick, qualityIndexTick } from './fresh.js';
import { langIndexTick } from './langindex.js';
import { createLiveCtx } from './ctx.js';
import { RedisSettingsBus } from './settings/bus.js';
import { createSettingsStore } from './settings/store.js';
import { bootConfigEnv, bootstrapEnv, lazyBootstrap, nonEmptyEnv } from './settings/bootstrapFiles.js';
import { jobFailed } from './errorlog.js';
import { healthTick } from './health.js';
import { hygieneDue, stopHygiene } from './hygiene/scan.js';
import { recoIndexDue, startRecoIndexListener, stopRecoIndex } from './reco/indexJob.js';
import { announceSetupCode } from './setup/code.js';
import { isOperational, isSetupComplete } from './setup/state.js';
import { autoUpdateTick, syncChannel } from './updater.js';
import { joinedStopsSettled } from './cast.js';

// the bootstrap keys open the database: env (incl. VAR_FILE) wins, else the bootstrap volume written by the init container (a missing
// file stops the start, naming the file); the settings store then layers the saved settings over env
const bootstrap = bootstrapEnv(process.env, lazyBootstrap()); // reads only the files whose key env does not provide
const env = nonEmptyEnv(process.env); // empty = unset, as compose passes every optional key as `${KEY:-}`
const boot = loadConfig(bootConfigEnv(process.env, bootstrap));
const pool = new pg.Pool({ connectionString: boot.DATABASE_URL, max: 10 });
await migrate(pool);
const redis = new Redis(boot.REDIS_URL);
const kv = new RedisKV(redis);
const encKey = keyFromBase64(boot.APP_ENC_KEY);
// the store logs key names only, never values; before the app (and its logger) exists, to the console
const logTo: { app?: { warn(o: object, m: string): void } } = {};
const log = { warn: (o: object, m: string) => (logTo.app ? logTo.app.warn(o, m) : console.warn(m, o)) };
const settings = await createSettingsStore({ db: pool, encKey, env, bus: new RedisSettingsBus(redis), log, bootstrap });
const cfg = settings.current(); // startup checks and env-only keys; routes and jobs read ctx.cfg (live)
const mediaProblems = mediaConfigProblems(cfg);
if (mediaProblems.length) throw new Error(`MEDIA_SERVER=${cfg.MEDIA_SERVER}: ${mediaProblems.join('; ')}`);

const live = createLiveCtx({
  settings, kv, db: pool, encKey, fetchImpl: fetch,
  // discovered on the first login and again after a sign-in setting changes; an unreachable IdP answers 503, the backend stays up
  oidc: createLazyOidc(() => settings.current(), { log }),
  media: (c) => createMediaServer({ cfg: c, kv, db: pool, encKey }),
  requests: (c) => new SeerrClient(c.REQUESTS_URL, c.REQUESTS_API_KEY),
  roles: loadRoles(cfg.ROLE_TEMPLATES),
  // a media server's own change feed waits for the end of setup mode (empty settings until the wizard's media step); see syncMedia below
  operational: () => isOperational(ctx),
  log,
});
const { ctx } = live;
// the role catalogue: ROLE_TEMPLATES keys without a row become env roles (idempotent; migrate created the table)
await syncRoles(ctx);

const app = await buildApp(ctx);
logTo.app = app.log;
// livetv reaches the backend from a private address but never proxies a client: its X-Forwarded-For is never believed (review L3).
// Its address is looked up now and every 15 s (the timer does not keep the process alive).
watchUntrustedHost(URL.canParse(cfg.LIVETV_URL) ? new URL(cfg.LIVETV_URL).hostname : '');
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
// setting names removed in 2.0 that are still set (names only, never values; the admin banner shows them too, health.ts)
for (const msg of removedEnvNames()) app.log.warn(msg);
// setup mode (spec Part E): the jobs below ask isOperational on every tick, which reads the cached setup state warmed here; the instance
// that owns the background jobs prints a new setup code while setup is incomplete (every start replaces the previous one)
await isSetupComplete(ctx);
await announceSetupCode(ctx, app.log);
// the media server's own change feed (websocket, sync job …), if it has one; Jellyfin pushes webhooks instead. Deferred while the app
// is not operational (setup mode): the syncMedia timer below starts it then.
await live.startMedia({ dispatch: (e) => dispatchMediaEvent(ctx, e), log: app.log });
// one-off: push the changed role policies (guest transcoding) to every existing Jellyfin user
if (isOperational(ctx)) void reapplyPoliciesOnce(ctx).catch(jobFailed(ctx, app.log, 'role-reapply', 'role policy re-apply failed'));
pushEnabled(cfg); // validates the VAPID pair once (warns and disables push when invalid)
const offPush = settings.onChange(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'PUBLIC_URL'], () => { pushEnabled(settings.current()); });
// the updater installs the selected channel: tell it on every change (and once now); a missed call is repeated before each job
const offUpdater = settings.onChange(['UPDATE_CHANNEL', 'UPDATE_VERSION'], () => { void syncChannel(ctx).catch(() => undefined); });
void syncChannel(ctx).catch(() => undefined);
const akMissing = authentikConfigProblem(cfg);
if (akMissing) app.log.warn({ missing: akMissing }, `Authentik invitations disabled: ${akMissing.join(', ')} not set (see docs/integrations.md)`);
else if (!cfg.AUTHENTIK_URL) app.log.info('Authentik invitations off: invited people need an existing Authentik account');

const timers: NodeJS.Timeout[] = [];
// every tick returns early while setup is incomplete or a run-required setting is missing (isOperational, spec Part E1)
const op = () => isOperational(ctx);
timers.push(setInterval(() => { if (op()) parties.tick(); }, 1000));
// starts the media server's change feed once setup completes (startMedia above deferred it); a no-op once started
timers.push(setInterval(() => { if (op()) void live.syncMedia(); }, 5_000));
let pollTickBusy = false;
timers.push(setInterval(() => {
  if (pollTickBusy || !op()) return;
  pollTickBusy = true;
  void pollTick(ctx).catch(jobFailed(ctx, app.log, 'poll-tick', 'poll tick failed')).finally(() => { pollTickBusy = false; });
}, 5_000));
timers.push(setInterval(() => { if (op()) void resolveRequestedPolls(ctx).catch(jobFailed(ctx, app.log, 'poll-resolve', 'resolve failed')); }, 60_000));
timers.push(setInterval(() => { if (op()) void calendarNotifications(ctx).catch(jobFailed(ctx, app.log, 'calendar', 'calendar job failed')); }, 3600_000));
// always scheduled: PREVIEW_WARM applies live, the tick checks it
timers.push(setInterval(() => { if (op()) void previewWarmTick(ctx).catch(jobFailed(ctx, app.log, 'preview-warm', 'preview warm failed')); }, 60_000));
timers.push(setInterval(() => { if (op()) void reminderTick(ctx).catch(jobFailed(ctx, app.log, 'reminder', 'reminder tick failed')); }, 1800_000));
timers.push(setInterval(() => { if (op()) void nightlyTick(ctx).catch(jobFailed(ctx, app.log, 'playback-check', 'playback check failed')); }, 600_000));
timers.push(setInterval(() => { if (op()) void hevcTick(ctx).catch(jobFailed(ctx, app.log, 'hevc-probe', 'HEVC probe failed')); }, 600_000)); // timed probe of the HEVC conversion while unproven and idle
timers.push(setInterval(() => { if (op()) void convBenchTick(ctx).catch(jobFailed(ctx, app.log, 'conv-bench', 'conversion benchmark failed')); }, 600_000)); // the conversion benchmark once while unmeasured (or stale) and idle
void detectLivetv(ctx).catch(() => undefined); // the first look at the optional livetv container, so a running one is not mistaken for a new one
timers.push(setInterval(() => { void livetvDetectTick(ctx).catch(jobFailed(ctx, app.log, 'livetv-detect', 'livetv detection failed')); }, 60_000)); // installed or not: featureFlags, the admin entry, the benchmark after enabling
timers.push(setInterval(() => { if (op()) void livetvIngestTick(ctx, app.log).catch(jobFailed(ctx, app.log, 'livetv-ingest', 'livetv ingest retry failed')); }, 60_000)); // re-sends the SRT push set after a failed sync (ltv:ingest:dirty), only while livetv is installed
// stops streams 60 s after their last viewer, re-sends the push set after a livetv restart, notes stream and push events (one runner: KV ltv:tick)
let livetvTickBusy = false;
timers.push(setInterval(() => {
  if (livetvTickBusy || !op() || !livetvInstalled(ctx)) return;
  livetvTickBusy = true;
  void livetvTick(ctx).catch(jobFailed(ctx, app.log, 'livetv-tick', 'livetv stream tick failed')).finally(() => { livetvTickBusy = false; });
}, 15_000));
let livetvRefreshBusy = false;
timers.push(setInterval(() => {
  // provider lists due for a refresh (spec §10 jobs); only while livetv is there, else every source would fail and notify the admins
  if (livetvRefreshBusy || !op() || !livetvInstalled(ctx)) return;
  livetvRefreshBusy = true;
  void livetvRefreshTick(ctx).catch(jobFailed(ctx, app.log, 'livetv-refresh', 'livetv refresh tick failed')).finally(() => { livetvRefreshBusy = false; });
}, 300_000));
// livetvEpgPrune (spec §10 jobs): once a day from 04:10 server time (a KV day key keeps it to one run across processes); database only
timers.push(setInterval(() => { if (op()) void livetvEpgPruneTick(ctx).catch(jobFailed(ctx, app.log, 'livetv-epg-prune', 'livetv EPG prune failed')); }, 600_000));
timers.push(setInterval(() => { if (op()) void digestTick(ctx).catch(jobFailed(ctx, app.log, 'digest', 'digest tick failed')); }, 600_000));
let expiryBusy = false; // a slow tick (media server) must not overlap the next one
timers.push(setInterval(() => {
  if (expiryBusy || !op()) return;
  expiryBusy = true;
  void expiryTick(ctx).catch(jobFailed(ctx, app.log, 'access-expiry', 'access expiry tick failed')).finally(() => { expiryBusy = false; });
}, 60_000)); // access-until warnings + automatic lock
let deletionBusy = false; // the steps call the media server, the request service and Authentik: never two runs at once
timers.push(setInterval(() => {
  if (deletionBusy || !op()) return;
  deletionBusy = true;
  void deletionTick(ctx).catch(jobFailed(ctx, app.log, 'account-deletion', 'account deletion tick failed')).finally(() => { deletionBusy = false; });
}, 60_000)); // final account deletion after the grace period
if (cfg.BACKGROUND_JOBS === 'true') {
  // always scheduled: DOWNLOADS_ENABLED applies live, each tick checks it
  const downloadsOn = () => op() && ctx.cfg.DOWNLOADS_ENABLED === 'true';
  timers.push(setInterval(() => {
    if (downloadsOn()) void startPreparerTick(ctx).catch(jobFailed(ctx, app.log, 'download-prep', 'download prep tick failed'));
  }, 15_000));
  timers.push(setInterval(() => {
    if (downloadsOn()) void gcDownloads(ctx).then(() => gcLicenses(ctx)).catch(jobFailed(ctx, app.log, 'download-gc', 'download gc failed'));
  }, 600_000));
  if (downloadsOn()) void startPreparerTick(ctx).catch(jobFailed(ctx, app.log, 'download-prep', 'download prep start failed'));
  timers.push(setInterval(() => { if (op()) void healthTick(ctx); }, 60_000)); // admin health snapshot (kv health:snap); never throws
  // AUTO_UPDATE=nightly-window through the updater (one start per day across instances) + the result audit of updater jobs
  timers.push(setInterval(() => { if (op()) void autoUpdateTick(ctx, new Date(), app.log).catch(jobFailed(ctx, app.log, 'auto-update', 'auto update tick failed')); }, 60_000));
  if (op()) void healthTick(ctx);
  timers.push(setInterval(() => { if (op()) void langIndexTick(ctx); }, 1800_000)); // self-limits to every 12 h, never throws
  if (op()) void langIndexTick(ctx);
  timers.push(setInterval(() => { if (op()) void qualityIndexTick(ctx); }, 1800_000)); // 4K / HDR browse filter; self-limits to every 12 h, never throws
  if (op()) void qualityIndexTick(ctx);
  timers.push(setInterval(() => { if (op()) void leavingTick(ctx).catch(jobFailed(ctx, app.log, 'leaving-soon', 'leaving-soon tick failed')); }, 1800_000)); // expired dates + 7-day / last-day notices
  timers.push(setInterval(() => { if (op()) void pollJellyfinSessions(ctx).catch(jobFailed(ctx, app.log, 'session-poll', 'session poll failed')); }, 10_000));
  // library hygiene (Block 22): every 30 min + early after library additions, checked every minute from 2 min after start; never throws
  const hygieneStart = setTimeout(() => {
    if (op()) void hygieneDue(ctx);
    timers.push(setInterval(() => { if (op()) void hygieneDue(ctx); }, 60_000));
  }, 120_000);
  timers.push(hygieneStart); // clearInterval also clears a timeout
  // recommendation item index (R1): incremental after library additions (media.event), a full pass on the first run and nightly; checked every minute from 90 s after start; never throws
  startRecoIndexListener(ctx); // lives as long as the process
  const recoStart = setTimeout(() => {
    if (op()) void recoIndexDue(ctx);
    timers.push(setInterval(() => { if (op()) void recoIndexDue(ctx); }, 60_000));
  }, 90_000);
  timers.push(recoStart);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    timers.forEach(clearInterval);
    stopHygiene();
    stopRecoIndex();
    offPush();
    offUpdater();
    // continuous AirPlay stops a logout / revoke started in the background reach the media server first (at most 5 s)
    void joinedStopsSettled(5_000).catch(() => undefined)
      .then(() => live.close()).catch(() => undefined)
      .then(() => settings.close()).catch(() => undefined)
      .then(() => app.close()).then(() => process.exit(0));
  });
}
