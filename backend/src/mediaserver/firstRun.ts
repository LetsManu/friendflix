// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomToken } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import { FALLBACK_LANGUAGE, instanceLanguage, type Language } from '../i18n.js';
import { MEDIA_SETUP } from '../media/setup.js';
import { MediaSetupError } from '../media/types.js';
import { containerTz } from '../routes/adminMediaserver.js';
import { saveWithProbes } from '../routes/adminSettings.js';
import { runProbe } from '../settings/probes.js';
import { updaterView, type TickLog, type UpdaterStatus } from '../updater.js';
import { MEDIA_ERRORS, mediaOp, startMediaJob } from './client.js';
import { ensureLibrary, managedKey, MANAGED_URL, publicInfo, refreshLibraries, setEncoding, signsIn, startupWizard } from './serverApi.js';
import { adminPassword, readManaged, type MediaManaged, type SetupStep } from './store.js';

/**
 * The first run of the managed media server without a person (spec "First run"): a background tick (BACKGROUND_JOBS=true, every 10 s,
 * not gated by the portal being operational: the wizard's media step runs it) that moves media_managed.setup one step at a time from
 * `applying` to `done`. Each step is idempotent and advances only after its work is confirmed, so a backend restart, a second instance
 * (the kv lock), a re-apply in the middle or a server that survived an earlier setup never duplicate the administrator, the API key or a
 * library. A failure keeps its step with a code in setup_error (*Nochmal* clears it and the step runs again); a startup wizard someone
 * else completed is `failed` / `wizard_taken`. Codes only: the admin password, the API key and server or updater text never reach
 * setup_error, a log or an audit row.
 */

const LOCK = 'media:managed:tick';
/** the last apply job the setup saw succeed (its finish-setup is started once per apply) */
const APPLY_JOB = 'media:managed:apply';
const finishKey = (applyId: string) => `media:managed:finish:${applyId}`;
/** whether an apply job carried the first-run password ('1') or not ('0'), recorded by the apply route when it starts the job */
const firstRunKey = (applyId: string) => `media:managed:firstrun:${applyId}`;
const WEEK = 7 * 86_400;

/** the apply route records whether the apply it started sent the first-run password (finishing skips finish-setup only on a '0') */
export async function recordApplyFirstRun(ctx: Pick<Ctx, 'kv'>, jobId: string, firstRun: boolean): Promise<void> {
  await ctx.kv.set(firstRunKey(jobId), firstRun ? '1' : '0', WEEK);
}
const ACTIVE: ReadonlySet<SetupStep> = new Set(['applying', 'first_run', 'api_key', 'libraries', 'hwaccel', 'finishing']);
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const RENDER_NODE = /^renderD[0-9]{1,4}$/;
const SETTING_KEYS = ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'] as const;

const TZ_COUNTRY: Record<string, string> = {
  'Europe/Berlin': 'DE', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH', 'Europe/Paris': 'FR', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT',
  'Europe/Warsaw': 'PL', 'Europe/Istanbul': 'TR', 'Europe/London': 'GB', 'America/New_York': 'US',
};
const LANG_COUNTRY: Record<Language, string> = { de: 'DE', en: 'GB', fr: 'FR', es: 'ES', it: 'IT', pl: 'PL', tr: 'TR' };

/** a step failure that is not the server's own (a job error, unhealthy): its code */
class StepFailed extends Error {
  constructor(readonly code: string) {
    super(`managed media server setup failed: ${code}`);
  }
}

/** the wizard's language settings: the instance language, the country from the container's time zone, else from the language */
export async function serverLocale(ctx: Pick<Ctx, 'db'>, tz = containerTz()): Promise<{ culture: string; language: string; country: string }> {
  const language = (await instanceLanguage(ctx)) ?? FALLBACK_LANGUAGE;
  return { culture: `${language}-${LANG_COUNTRY[language]}`, language, country: TZ_COUNTRY[tz] ?? LANG_COUNTRY[language] };
}

type Next = SetupStep | 'waiting';
interface Step { ctx: Ctx; m: MediaManaged; status: UpdaterStatus | null }

async function admin(ctx: Ctx, m: MediaManaged): Promise<{ user: string; password: string }> {
  const password = await adminPassword(ctx);
  if (!m.adminUser || !password) throw new StepFailed('unexpected');
  return { user: m.adminUser, password };
}

/** 1. the apply job the route started: running waits, succeeded goes on, anything else is its error */
async function applying({ ctx, status }: Step): Promise<Next> {
  if (!status) return 'waiting';
  const j = status.job;
  if (j?.action !== 'mediaserver-apply') {
    if (status.busy) return 'waiting';
    // no apply job to read (the updater restarted since): a running container is the apply's; its id is unknown, so a finish key of
    // its own (never the one of an earlier apply)
    if (status.mediaserver?.container?.state !== 'running') throw new StepFailed('interrupted');
    await ctx.kv.set(APPLY_JOB, `unseen-${randomToken(8)}`, WEEK);
    return 'first_run';
  }
  if (j.state === 'running') return 'waiting';
  if (j.state !== 'succeeded') throw new StepFailed(j.error ?? 'unexpected');
  await ctx.kv.set(APPLY_JOB, j.id, WEEK);
  return 'first_run';
}

/** whether the current step started more than 3 minutes ago (the database's clock: every step change sets updated_at) */
async function stepOlderThan3Min(ctx: Ctx): Promise<boolean> {
  const r = await ctx.db.query<{ late: boolean }>("select updated_at < now() - interval '3 minutes' as late from media_managed where id = 1");
  return r.rows[0]?.late === true;
}

/** 2. the server answers; Jellyfin's startup wizard (Ferrofin creates its administrator from its first-run environment) */
async function firstRun({ ctx, m }: Step): Promise<Next> {
  const info = await publicInfo(ctx.fetchImpl, MANAGED_URL);
  if (!info) {
    if (await stepOlderThan3Min(ctx)) throw new StepFailed('unhealthy');
    return 'waiting';
  }
  if (m.kind === 'ferrofin') return 'api_key';
  const a = await admin(ctx, m);
  if (info.wizardDone) {
    // complete already: FriendFlix's own administrator from an earlier run (a re-apply, a switch back) or someone else's
    if (await signsIn(ctx.fetchImpl, MANAGED_URL, a.user, a.password)) return 'api_key';
    throw new MediaSetupError('wizard_taken');
  }
  const loc = await serverLocale(ctx);
  await startupWizard(ctx.fetchImpl, MANAGED_URL, { name: a.user, password: a.password, ...loc });
  return 'api_key';
}

/** 3. the API key: a saved managed key that works is kept; otherwise a new one is created and saved (source db, audited) */
async function apiKey({ ctx, m }: Step): Promise<Next> {
  if (managedKey(ctx.cfg)) {
    const probe = await runProbe(ctx, 'media', ctx.cfg);
    if (probe.ok) return 'libraries';
    // a server that does not answer says nothing about the key: never a second key for one that may work
    if (probe.code !== 'unauthorized' && probe.code !== 'not_admin') throw new StepFailed(probe.code === 'timeout' ? 'unreachable' : probe.code);
  }
  const a = await admin(ctx, m);
  const auto = MEDIA_SETUP.jellyfin!.auto!; // Ferrofin speaks Jellyfin's API
  const values = await auto.run({ url: MANAGED_URL, username: a.user, password: a.password }, { fetchImpl: ctx.fetchImpl, appVersion: ctx.cfg.APP_VERSION ?? 'dev' });
  const r = await saveWithProbes(ctx, values, { force: false, actor: null, allowedKeys: SETTING_KEYS });
  if ('errors' in r || 'probe' in r) {
    // not saved: the new key would be orphaned
    await auto.revoke?.(values, { fetchImpl: ctx.fetchImpl }).catch(() => undefined);
    throw new StepFailed('probe' in r ? r.probe.code : 'invalid');
  }
  return 'libraries';
}

/** marks one library entry created, in place (a concurrent apply may rewrite the list meanwhile) */
async function markCreated(ctx: Ctx, slug: string): Promise<void> {
  await ctx.db.query(
    `update media_managed set libraries = coalesce((select jsonb_agg(case when e->>'slug' = $1 then jsonb_set(e, '{created}', 'true') else e end order by n)
       from jsonb_array_elements(libraries) with ordinality as t(e, n)), '[]'::jsonb), updated_at = now() where id = 1`, [slug]);
}

/**
 * 4. one library per entry not created yet (an existing one of that name on its folder counts), one per tick (each tick's server calls
 * stay well inside the lock's 60 s); once none is left, a scan
 */
async function libraries({ ctx, m }: Step): Promise<Next> {
  const key = managedKey(ctx.cfg);
  if (!key) return 'api_key';
  const lib = m.libraries.find((l) => !l.created);
  if (lib) {
    await ensureLibrary(ctx.fetchImpl, MANAGED_URL, key, lib, await serverLocale(ctx));
    await markCreated(ctx, lib.slug);
    return 'libraries';
  }
  await refreshLibraries(ctx.fetchImpl, MANAGED_URL, key);
  return 'hwaccel';
}

/** 5. the server's encoding settings for the chosen GPU (the vendor and render node from the updater's detection) */
async function hwaccel({ ctx, status }: Step): Promise<Next> {
  const key = managedKey(ctx.cfg);
  if (!key) return 'api_key';
  const gpu = status?.mediaserver?.desired?.gpu;
  if (!gpu) return 'waiting';
  let vendor: 'intel' | 'amd' | 'other' | null = null;
  let node: string | null = null;
  if (gpu === 'dri') {
    const r = await mediaOp(ctx, { op: 'gpu' });
    if (r?.status !== 200) {
      const e = (r?.json as { error?: unknown } | null)?.error;
      throw new StepFailed(typeof e === 'string' && (MEDIA_ERRORS as readonly string[]).includes(e) ? e : 'unreachable');
    }
    const dri = (r.json as { dri?: unknown } | null)?.dri;
    const nodes = (Array.isArray(dri) ? dri : []).flatMap((d): Array<{ node: string; vendor: 'intel' | 'amd' | 'other' }> => {
      const o = (d ?? {}) as Record<string, unknown>;
      return typeof o.node === 'string' && RENDER_NODE.test(o.node) ? [{ node: o.node, vendor: o.vendor === 'intel' || o.vendor === 'amd' ? o.vendor : 'other' }] : [];
    });
    const pick = nodes.find((n) => n.vendor !== 'other') ?? nodes[0];
    vendor = pick?.vendor ?? null;
    node = pick?.node ?? null;
  }
  await setEncoding(ctx.fetchImpl, MANAGED_URL, key, { gpu, vendor, node });
  return 'finishing';
}

/** 6. Ferrofin: finish-setup once per apply (recreated without the password variable), then done; Jellyfin: done */
async function finishing({ ctx, m, status }: Step): Promise<Next> {
  if (m.kind !== 'ferrofin') return 'done';
  if (!status) return 'waiting';
  const applyId = await ctx.kv.get(APPLY_JOB);
  const fk = finishKey(applyId ?? 'unknown');
  const finishId = await ctx.kv.get(fk);
  if (!finishId) {
    if (status.busy) return 'waiting';
    // nothing to finish only when the apply is known to have sent no password AND the container reads as current (a template the
    // updater could not read also reads current); a missing record, a first-run apply or an apply never seen: finish-setup (fail closed)
    const sent = applyId ? await ctx.kv.get(firstRunKey(applyId)) : null;
    if (sent === '0' && status.mediaserver?.container?.template === 'current') return 'done';
    const r = await startMediaJob(ctx, { op: 'finish-setup' }, null, {});
    if (!r.ok) {
      if (r.error === 'busy' || r.error === 'not_available') return 'waiting';
      throw new StepFailed(r.error);
    }
    if ('job' in r) await ctx.kv.set(fk, r.job.id, WEEK);
    return 'waiting';
  }
  const j = status.job;
  if (j?.id === finishId) {
    if (j.state === 'running') return 'waiting';
    if (j.state === 'succeeded') return 'done';
    await ctx.kv.del(fk); // *Nochmal* starts it again
    throw new StepFailed(j.error ?? 'unexpected');
  }
  if (status.busy) return 'waiting';
  // a later job hides the finish job's result: never read as done from the template (an unreadable one reads current too); the next
  // tick starts finish-setup again (a recreate without the password variable either way)
  await ctx.kv.del(fk);
  return 'waiting';
}

const STEPS: Partial<Record<SetupStep, (s: Step) => Promise<Next>>> = {
  applying, first_run: firstRun, api_key: apiKey, libraries, hwaccel, finishing,
};

/** the step changes only while it is still the one this tick ran (an apply meanwhile sets its own) */
async function advance(ctx: Ctx, from: SetupStep, to: SetupStep): Promise<void> {
  await ctx.db.query('update media_managed set setup = $2, setup_error = null, updated_at = now() where id = 1 and setup = $1 and setup_error is null', [from, to]);
}
async function fail(ctx: Ctx, from: SetupStep, code: string, setup: SetupStep = from): Promise<void> {
  await ctx.db.query('update media_managed set setup = $2, setup_error = $3, updated_at = now() where id = 1 and setup = $1 and setup_error is null', [from, setup, code]);
}

const codeOf = (e: unknown): string | null => {
  const c = e instanceof MediaSetupError || e instanceof StepFailed ? e.code : null;
  return c === null ? null : CODE.test(c) ? c : 'unexpected';
};

/**
 * One tick: `idle` unless a setup runs without an error, `locked` while another tick (another instance) holds `media:managed:tick`,
 * `waiting` while a step waits (the apply or finish job, the server starting), else the step it is on now.
 */
export async function mediaManagedTick(ctx: Ctx, log?: TickLog): Promise<SetupStep | 'idle' | 'locked' | 'waiting'> {
  const before = await readManaged(ctx.db);
  if (!ACTIVE.has(before.setup) || before.setupError !== null || !before.kind) return 'idle';
  const token = randomToken(12);
  if (!(await ctx.kv.setnx(LOCK, token, 60))) return 'locked';
  try {
    const m = await readManaged(ctx.db); // under the lock: the step another tick may just have finished
    const run = STEPS[m.setup];
    if (!run || m.setupError !== null || !m.kind) return 'idle';
    const view = await updaterView(ctx);
    const status = 'status' in view ? view.status : null;
    try {
      if (m.setup !== 'applying' && m.setup !== 'finishing' && status) {
        // the server is being recreated (an apply after a folder or GPU change, another media job): wait; an apply that failed stops here
        if (status.busy) return 'waiting';
        const j = status.job;
        if (j?.action === 'mediaserver-apply' && j.state !== 'succeeded' && j.state !== 'running') throw new StepFailed(j.error ?? 'unexpected');
        // the apply this setup follows now (a re-apply after done comes back to a later step, not through applying)
        if (j?.action === 'mediaserver-apply' && j.state === 'succeeded') await ctx.kv.set(APPLY_JOB, j.id, WEEK);
      }
      const next = await run({ ctx, m, status });
      if (next === 'waiting') return 'waiting';
      await advance(ctx, m.setup, next);
      return next;
    } catch (e) {
      const code = codeOf(e);
      if (code === null) throw e;
      log?.warn({ step: m.setup, code }, 'managed media server setup step failed');
      const failed = code === 'wizard_taken';
      await fail(ctx, m.setup, code, failed ? 'failed' : m.setup);
      return failed ? 'failed' : m.setup;
    }
  } finally {
    await ctx.kv.delIfEquals(LOCK, token).catch(() => undefined);
  }
}
