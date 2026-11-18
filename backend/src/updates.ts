// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { audit } from './audit.js';
import { buildInfo, channelTag, channelUpdate, envLine, hookWithTag, withTag, type BuildKind, type Channel, type RunningChannel } from './channel.js';
import type { Ctx } from './ctx.js';
import { installedBuild } from './installed.js';
import { abandonRedeploy, beginRedeploy, claimRedeploy, settleRedeploy } from './redeploy.js';
import { REPORT_SERVICES, updaterView } from './updater.js';
import { appVersion, codenameFor, compareSemver, parseSemver } from './version.js';

const TTL = 600;
const CACHE_MS = 'update:info:';
/** the kv key of the cached GitHub answer for the installed build (installed.ts) */
const infoKey = (cfg: Ctx['cfg'], installed: string): string => `${CACHE_MS}${cfg.UPDATE_REPO}:${installed}:${appVersion(cfg).version}`;
/** the key of the GitHub answer cached last (what cachedReleaseVersion reads: the installed build's own cache may run out first) */
const lastInfoKey = (cfg: Ctx['cfg']): string => `${CACHE_MS}${cfg.UPDATE_REPO}:last`;
const GH = 'https://api.github.com';

export interface Latest { sha: string; date: string; runUrl: string }
export interface CommitInfo { sha: string; message: string; author: string; date: string; url: string }
/** newest published GitHub release (releases/latest) */
export interface Release { version: string; codename: string | null; tag: string; name: string; url: string; publishedAt: string | null; notes: string }
export interface UpdateInfo {
  current: { sha: string; builtAt: string | null; version: string; codename: string };
  /** newest release; null when none is published yet (or its tag is not a version) */
  release: Release | null;
  /** on the selected channel (stable: a newer release; nightly: newer commits on main); null = nothing to compare with */
  updateAvailable: boolean | null;
  /** the selected channel (setting UPDATE_CHANNEL) and the one this build runs (derived from its commit, see channel.ts) */
  channel: {
    selected: Channel;
    /** the fixed version of the pinned channel (UPDATE_VERSION) */
    version: string | null;
    running: RunningChannel | null;
    build: BuildKind | null;
    /** "1.1.0" or "1.1.0-nightly · abc1234" */
    label: string;
    /** UPDATE_CHANNEL is set in the environment: the switch cannot change it */
    locked: boolean;
    /** the `.env` line for the selected channel */
    envLine: string;
  };
  /** secondary: newest successful CI build on main and how many commits it is ahead of the installed build */
  latest: Latest | null;
  behind: number | null;
  commits: CommitInfo[];
  portainer: PortainerSetup;
  autoUpdateNote: true;
  error?: string;
}

/**
 * The API way wins when it is complete: it sets FF_TAG and reports real success or failure, and its key does not go stale. A
 * webhook address does (Portainer issues a new token when the stack is recreated or its webhook toggled), so with both set a
 * dead webhook must not shadow a working API. The webhook is used only when the API settings are not all there.
 */
export function portainerMode(ctx: Ctx): 'webhook' | 'api' | null {
  const c = ctx.cfg;
  if (c.PORTAINER_URL && c.PORTAINER_API_KEY && c.PORTAINER_STACK_ID) return 'api';
  if (c.PORTAINER_WEBHOOK_URL) return 'webhook';
  return null;
}

/** the three settings the Portainer API way needs (PORTAINER_ENDPOINT_ID is read from the stack) */
export const PORTAINER_API_SETTINGS = ['PORTAINER_URL', 'PORTAINER_API_KEY', 'PORTAINER_STACK_ID'] as const;
/**
 * Whether Admin -> Update can redeploy through Portainer, and when the API way is set up only in part, which of its settings are
 * still missing (names only, never a value): without them "Update now" has nothing to call, and the page says what to add.
 */
export interface PortainerSetup { configured: boolean; mode: 'webhook' | 'api' | null; missing: string[] }
export function portainerSetup(ctx: Ctx): PortainerSetup {
  const mode = portainerMode(ctx);
  const c = ctx.cfg as unknown as Record<string, unknown>;
  const some = PORTAINER_API_SETTINGS.some((k) => c[k]);
  return { configured: mode !== null, mode, missing: mode === null && some ? PORTAINER_API_SETTINGS.filter((k) => !c[k]) : [] };
}

/** GitHub GET; `null` for a 404 when `missingOk` (e.g. no release published yet) */
async function gh<T>(ctx: Ctx, path: string, missingOk = false): Promise<T | null> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'friendflix' };
  if (ctx.cfg.GITHUB_TOKEN) headers.authorization = `Bearer ${ctx.cfg.GITHUB_TOKEN}`;
  const r = await ctx.fetchImpl(`${GH}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (missingOk && r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return (await r.json()) as T;
}

type Fetched = Pick<UpdateInfo, 'release' | 'latest' | 'behind' | 'commits'>;
const NOTES_MAX = 20_000;

async function fetchRelease(ctx: Ctx): Promise<Release | null> {
  const r = await gh<{ tag_name?: string; name?: string | null; html_url?: string; published_at?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean }>(ctx, `/repos/${ctx.cfg.UPDATE_REPO}/releases/latest`, true);
  const tag = r?.tag_name ?? '';
  if (!r || r.draft || r.prerelease || !parseSemver(tag)) return null;
  const version = tag.replace(/^v/, '');
  return { version, codename: codenameFor(version), tag, name: r.name || tag, url: r.html_url ?? '', publishedAt: r.published_at ?? null, notes: (r.body ?? '').slice(0, NOTES_MAX) };
}

/** the newest green CI run on main and how far the installed build `cur` is behind it */
async function fetchMain(ctx: Ctx, cur: string): Promise<Pick<Fetched, 'latest' | 'behind' | 'commits'> | null> {
  const repo = ctx.cfg.UPDATE_REPO;
  const runs = await gh<{ workflow_runs?: Array<{ head_sha: string; updated_at: string; html_url: string }> }>(ctx, `/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&status=success&event=push&per_page=1`);
  const run = runs?.workflow_runs?.[0];
  if (!run) return null;
  const latest: Latest = { sha: run.head_sha, date: run.updated_at, runUrl: run.html_url };
  if (cur === 'dev' || cur === latest.sha) return { latest, behind: cur === latest.sha ? 0 : null, commits: [] };
  try {
    const cmp = (await gh<{ ahead_by: number; commits?: Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } }; author?: { login?: string } | null }> }>(ctx, `/repos/${repo}/compare/${cur}...${latest.sha}`))!;
    const commits = (cmp.commits ?? []).slice(-50).reverse().map((c) => ({
      sha: c.sha, message: c.commit.message.split('\n')[0]!, author: c.commit.author?.name ?? c.author?.login ?? '', date: c.commit.author?.date ?? '', url: c.html_url,
    }));
    return { latest, behind: cmp.ahead_by, commits };
  } catch {
    return { latest, behind: null, commits: [] }; // unknown/rebased current sha: still show the latest version
  }
}

async function fetchLatest(ctx: Ctx, cur: string): Promise<Fetched> {
  const [release, main] = await Promise.all([fetchRelease(ctx), fetchMain(ctx, cur)]);
  if (!release && !main) throw new Error('no release and no successful CI run found');
  return { release, ...(main ?? { latest: null, behind: null, commits: [] }) };
}

/** The newest release's version from the cached GitHub answer only (no request); null when nothing is cached or there is no release. */
export async function cachedReleaseVersion(ctx: Pick<Ctx, 'kv' | 'cfg'>): Promise<string | null> {
  try {
    const key = await ctx.kv.get(lastInfoKey(ctx.cfg));
    const hit = key ? await ctx.kv.get(key) : null;
    return hit ? ((JSON.parse(hit) as Partial<Fetched>).release?.version ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * With the updater (UPDATER_URL), whether a service an update installs (backend, gateway, web, livetv; not the updater itself, that
 * is its own update) runs another digest than the registry's for the nightly tag: any differs -> true, all the same -> false;
 * anything unknown (no updater, an older one, a registry outage, another tag) -> null.
 */
async function updaterDigestsDiffer(ctx: Ctx): Promise<boolean | null> {
  if (!ctx.cfg.UPDATER_URL) return null;
  const v = await updaterView(ctx).catch(() => null);
  const s = v && 'status' in v ? v.status : null;
  const core = s?.targetTag === 'nightly' ? s.services.filter((x) => (REPORT_SERVICES as readonly string[]).includes(x.service)) : [];
  if (!core.length) return null;
  if (core.some((x) => x.changed === true)) return true;
  return core.every((x) => x.changed === false) ? false : null;
}

/**
 * Installed vs newest release (stable channel) or vs the newest CI build on main (nightly channel: commits ahead; on stable
 * secondary info, and the only comparison before the first release). GitHub answers are cached for 10 min (unauthenticated limit: 60/h); an outage never throws.
 * "Installed" is the installed build (installed.ts): its commit is compared and "built at" is its commit time.
 */
export async function updateInfo(ctx: Ctx, refresh = false): Promise<UpdateInfo> {
  const ver = appVersion(ctx.cfg);
  const installed = await installedBuild(ctx, { fresh: refresh });
  const base = { current: { sha: installed.commit, builtAt: installed.time, ...ver }, portainer: portainerSetup(ctx), autoUpdateNote: true as const };
  const selected: Channel = ctx.cfg.UPDATE_CHANNEL;
  const pinned = selected === 'pinned' ? (ctx.cfg.UPDATE_VERSION ?? null) : null;
  let locked = false;
  try { locked = ctx.settings.sources().UPDATE_CHANNEL === 'env'; } catch { /* no store (tests): not locked */ }
  const [b, digestsDiffer] = await Promise.all([buildInfo(ctx, { refresh, installed }), selected === 'nightly' ? updaterDigestsDiffer(ctx) : Promise.resolve(null)]);
  const channel = { selected, version: pinned, running: b.channel, build: b.build, label: b.label, locked, envLine: envLine(selected, pinned) };
  const withState = (f: Fetched): UpdateInfo => ({
    ...base, ...f, channel,
    updateAvailable: channelUpdate(selected, { releaseNewer: f.release ? compareSemver(f.release.version, ver.version) > 0 : null, behind: f.behind, pinnedDiffers: pinned ? pinned !== ver.version : null, digestsDiffer }),
  });
  const key = infoKey(ctx.cfg, installed.commit);
  if (!refresh) {
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) return withState(JSON.parse(hit) as Fetched);
  }
  try {
    const f = await fetchLatest(ctx, installed.commit);
    await ctx.kv.set(key, JSON.stringify(f), TTL).then(() => ctx.kv.set(lastInfoKey(ctx.cfg), key, TTL)).catch(() => undefined);
    return withState(f);
  } catch (e) {
    return { ...base, channel, release: null, updateAvailable: null, latest: null, behind: null, commits: [], error: e instanceof Error && e.message.startsWith('GitHub ') ? e.message : 'github_unreachable' };
  }
}

/**
 * `pending`: Portainer had not answered within the grace window (it goes on; a later answer goes to onLate). `sync`: its API
 * answered once it was done (Portainer before 2.36 redeploys, then answers with the stack at Status 1; later versions answer
 * at once with Status 3, "deploying"); a webhook answer or one without a readable stack says nothing about that. Step `deploy`:
 * the answer was 2xx but the stack it returned is in error (Status 4).
 */
export type TriggerResult = { ok: true; mode: 'webhook' | 'api'; pending?: true; sync?: boolean } | { ok: false; status: number | null; error: string; step: 'webhook' | 'stack' | 'stack_file' | 'redeploy' | 'deploy'; code?: string };
/** Portainer's answer to the final call when it came only after triggerUpdate returned "started" (null status: no answer) */
export type LateAnswer = { ok: true; sync: boolean } | { ok: false; status: number | null; deploy?: true };
/** Portainer's API pulls and recreates before it answers (minutes); the answer is still wanted (redeploy.ts), so it may take this long */
const REDEPLOY_CALL_MS = 15 * 60_000;
/** Portainer's stack status (portainer.StackStatus): 1 active, 2 inactive, 3 deploying, 4 error */
const STACK_ACTIVE = 1, STACK_ERROR = 4;
/**
 * What a 2xx answer of the API's redeploy says: done (the stack it returns is active), failed (in error), or wait (deploying,
 * anything else, no readable body, or a webhook: the phase then follows from what runs)
 */
async function answerOf(r: Response, mode: 'webhook' | 'api'): Promise<'done' | 'failed' | 'wait'> {
  if (mode === 'webhook') { void r.body?.cancel().catch(() => undefined); return 'wait'; }
  const b = (await r.json().catch(() => null)) as { Status?: unknown } | null;
  return b?.Status === STACK_ACTIVE ? 'done' : b?.Status === STACK_ERROR ? 'failed' : 'wait';
}

/**
 * Starts the redeploy. The final call is raced against a short grace window: Portainer may recreate (= kill) this very
 * container while still answering, so a call that is merely slow counts as started; only a fast failure is reported here, a
 * later answer goes to `onLate` (redeploy.ts: a late refusal still ends the redeploy as failed instead of being dropped).
 * The environment is the stack's own (its EndpointId): Portainer moves a stack to whatever endpointId the redeploy names, so
 * PORTAINER_ENDPOINT_ID (default 1) is only used when Portainer does not say.
 */
export async function triggerUpdate(ctx: Ctx, mode: 'webhook' | 'api', onLate?: (a: LateAnswer) => void): Promise<TriggerResult> {
  // the selected channel goes with the redeploy as FF_TAG: Portainer, not the updater, decides which images a Portainer stack runs
  if (ctx.cfg.UPDATE_CHANNEL === 'pinned' && !ctx.cfg.UPDATE_VERSION) return { ok: false, status: null, error: 'no_target', step: mode === 'webhook' ? 'webhook' : 'stack' };
  const tag = channelTag(ctx.cfg.UPDATE_CHANNEL, ctx.cfg.UPDATE_VERSION);
  const timeout = () => AbortSignal.timeout(30_000);
  // redirect manual everywhere: fetch would follow a redirect to another origin with the x-api-key header (and the webhook
  // token in the path); a 3xx is reported as Portainer's answer instead
  const send = async (url: string, init: RequestInit): Promise<Response | 'pending'> => {
    const p = ctx.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REDEPLOY_CALL_MS) });
    p.catch(() => undefined); // a late failure after we returned must not become an unhandled rejection
    const r = await Promise.race([p, new Promise<'pending'>((res) => setTimeout(res, 5000, 'pending').unref())]);
    if (r === 'pending' && onLate) {
      p.then(async (x) => {
        if (x.ok) { const a = await answerOf(x, mode); onLate(a === 'failed' ? { ok: false, status: null, deploy: true } : { ok: true, sync: a === 'done' }); }
        else { void x.body?.cancel().catch(() => undefined); onLate({ ok: false, status: x.status }); }
      }, () => onLate({ ok: false, status: null }));
    }
    return r;
  };
  const started = async (r: Response | 'pending'): Promise<TriggerResult> => {
    if (r === 'pending') return { ok: true, mode, pending: true };
    // a webhook that Portainer does not know (404): its token is stale (a recreated stack or a toggled webhook gets a new one)
    if (!r.ok) { void r.body?.cancel().catch(() => undefined); return fail(r.status, mode === 'webhook' && r.status === 404 ? 'webhook_gone' : 'portainer', step); }
    const a = await answerOf(r, mode);
    return a === 'failed' ? fail(null, 'portainer', 'deploy') : { ok: true, mode, sync: a === 'done' };
  };
  const fail = (status: number | null, error: string, step: 'webhook' | 'stack' | 'stack_file' | 'redeploy' | 'deploy'): TriggerResult => ({ ok: false, status, error, step });
  let step: 'webhook' | 'stack' | 'stack_file' | 'redeploy' | 'deploy' = mode === 'webhook' ? 'webhook' : 'stack';
  try {
    if (mode === 'webhook') {
      return await started(await send(hookWithTag(ctx.cfg.PORTAINER_WEBHOOK_URL!, tag), { method: 'POST' }));
    }
    const base = ctx.cfg.PORTAINER_URL!.replace(/\/+$/, '');
    const id = encodeURIComponent(ctx.cfg.PORTAINER_STACK_ID!);
    const headers = { 'x-api-key': ctx.cfg.PORTAINER_API_KEY! };
    const getJson = async <T>(path: string): Promise<T | number> => {
      const r = await ctx.fetchImpl(`${base}${path}`, { headers, redirect: 'manual', signal: timeout() });
      if (!r.ok) { void r.body?.cancel().catch(() => undefined); return r.status; }
      return (await r.json()) as T;
    };
    const stack = await getJson<{ Env?: unknown[] | null; GitConfig?: { ReferenceName?: string; Authentication?: { Username?: unknown } | null } | null; EndpointId?: unknown }>(`/api/stacks/${id}`);
    if (typeof stack === 'number') return fail(stack, 'portainer', step);
    const endpoint = Number.isInteger(stack.EndpointId) && (stack.EndpointId as number) > 0 ? stack.EndpointId as number : ctx.cfg.PORTAINER_ENDPOINT_ID;
    const eid = `endpointId=${endpoint}`;
    const env = withTag(stack.Env ?? [], tag); // Portainer replaces the stack env with what we send: all of it back, FF_TAG set
    let r: Response | 'pending';
    step = 'redeploy';
    if (stack.GitConfig) {
      // a private repository: Portainer clones with what the redeploy sends; authentication on with the stored user name and an
      // empty password keeps the stored credentials (Portainer 2.30 to 2.36 stackGitRedeploy). The password never leaves Portainer.
      const a = stack.GitConfig.Authentication;
      const user = a && typeof a === 'object' && typeof a.Username === 'string' ? a.Username : '';
      // only with a stored user name (Portainer returns the password emptied, so the name is the only sign of stored credentials);
      // `Authentication: {}` or a Portainer "git credential" (GitCredentialID) sends nothing, see docs/operations.md
      const auth = user ? { repositoryAuthentication: true, repositoryUsername: user, repositoryPassword: '' } : {};
      r = await send(`${base}/api/stacks/${id}/git/redeploy?${eid}`, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryReferenceName: stack.GitConfig.ReferenceName, ...auth, env, prune: false, pullImage: true, repullImageAndRedeploy: true }),
      });
    } else {
      step = 'stack_file';
      const file = await getJson<{ StackFileContent?: string }>(`/api/stacks/${id}/file`);
      if (typeof file === 'number') return fail(file, 'portainer', step);
      step = 'redeploy';
      r = await send(`${base}/api/stacks/${id}?${eid}`, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ stackFileContent: file.StackFileContent, env, prune: false, pullImage: true, repullImageAndRedeploy: true }),
      });
    }
    return await started(r);
  } catch (e) {
    // never include the message: node puts the request URL (webhook token) in it; the errno code alone is safe and tells DNS from firewall
    const raw = (e as { cause?: { code?: unknown }; name?: unknown })?.cause?.code ?? ((e as { name?: unknown })?.name === 'TimeoutError' ? 'ETIMEDOUT' : undefined);
    const code = typeof raw === 'string' && /^[A-Z_]{2,40}$/.test(raw) ? raw : undefined;
    return { ...fail(null, 'portainer_unreachable', step), ...(code ? { code } : {}) } as TriggerResult;
  }
}

/**
 * The Portainer redeploy, audited twice: system.update before the call (from/to, the mode; it survives Portainer recreating
 * this backend mid-call) and system.update_result after it (started, or failed with error/step/status/code, never the URL).
 * `actor` null = the automatic update. Used by Admin -> Update without the updater and by the updater path when the stack is
 * Portainer's (updater.ts startJob / autoUpdateTick).
 */
export async function redeployViaPortainer(ctx: Ctx, actor: string | null, mode: 'webhook' | 'api', info?: UpdateInfo, opts: { updater?: boolean; forced?: boolean } = {}): Promise<TriggerResult> {
  // one redeploy at a time, across backend instances: a second start while one runs is refused (busy), nothing is sent
  const id = await claimRedeploy(ctx);
  if (!id) return { ok: false, status: null, error: 'busy', step: mode === 'webhook' ? 'webhook' : 'stack' };
  const auto = actor ? {} : { auto: true };
  let i: UpdateInfo;
  try {
    i = info ?? await updateInfo(ctx);
    await audit(ctx, actor, 'system.update', undefined, {
      from: i.current.sha, to: i.latest?.sha ?? null, fromVersion: i.current.version, toVersion: i.release?.version ?? null, mode, tag: channelTag(ctx.cfg.UPDATE_CHANNEL, ctx.cfg.UPDATE_VERSION), ...auto, ...(opts.forced ? { forced: true } : {}),
    });
    if (!(await beginRedeploy(ctx, id, mode, channelTag(ctx.cfg.UPDATE_CHANNEL, ctx.cfg.UPDATE_VERSION), opts.updater === true, Date.now(), 3_000, opts.forced === true))) {
      // not recorded (the store or its mutex not available): nothing is sent, the page could not follow it
      await abandonRedeploy(ctx, id);
      await audit(ctx, actor, 'system.update_result', undefined, { mode, toVersion: i.release?.version ?? null, ...auto, result: 'failed', error: 'unavailable' });
      return { ok: false, status: null, error: 'unavailable', step: mode === 'webhook' ? 'webhook' : 'stack' };
    }
  } catch (e) {
    await abandonRedeploy(ctx, id); // nothing was sent: the slot is free again
    throw e;
  }
  // a refusal that comes after "started" went out (the API answers once Portainer is done) still ends the redeploy as failed
  const late = (a: LateAnswer) => {
    // no answer, or a proxy in front of Portainer giving up (502/503/504, e.g. a 60 s read timeout) is not Portainer's verdict:
    // Portainer goes on, the phase follows from what runs
    // a 2xx whose stack is in error (Status 4) is Portainer's verdict too
    if (!a.ok && !a.deploy && (a.status === null || a.status >= 502)) return;
    const step = !a.ok && a.deploy ? 'deploy' : 'redeploy';
    const error = !a.ok && mode === 'webhook' && a.status === 404 ? 'webhook_gone' : 'portainer';
    void settleRedeploy(ctx, id, a.ok ? { ok: true, sync: a.sync } : { ok: false, error, step, status: a.status })
      .then(() => (a.ok ? undefined : audit(ctx, actor, 'system.update_result', undefined, { mode, ...auto, result: 'failed', late: true, error, step, status: a.status })))
      .catch(() => undefined);
  };
  const r = await triggerUpdate(ctx, mode, late);
  if (!r.ok || !r.pending) await settleRedeploy(ctx, id, r.ok ? { ok: true, sync: r.sync === true } : r).catch(() => undefined);
  await audit(ctx, actor, 'system.update_result', undefined, {
    mode, toVersion: i.release?.version ?? null, ...auto,
    ...(r.ok ? { result: 'started' } : { result: 'failed', error: r.error, step: r.step, status: r.status, ...(r.code ? { code: r.code } : {}) }),
  });
  return r;
}
