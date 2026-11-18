// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { detectLivetv } from './livetv/detect.js';
import { updaterView } from './updater.js';
import { imageCommit } from './version.js';

/**
 * The installed build: which build runs. Images are built only when their inputs changed, so the services of one stack carry
 * different image commits (FF_IMAGE_COMMIT) and the backend's own says nothing about a newer web or gateway. The installed build is
 * the newest image commit (by commit time) among the FriendFlix services an update installs: from the updater's listing when it
 * answers, else by asking the services (web's /_app/version.json, the gateway's /health, livetv's health), the backend's own
 * otherwise. Whatever cannot be told (a service without a commit, a commit time GitHub does not give) falls back to this backend's
 * own image commit (`source: 'self'`), never to "the newest of the rest". Cached 10 minutes.
 */
export interface InstalledBuild {
  /** 40 hex, or 'dev' for a local build */
  commit: string;
  /** the commit time (ISO) of `commit`; null when unknown */
  time: string | null;
  source: 'updater' | 'probes' | 'self';
  /** per service its image commit and (from the updater) the digest it runs */
  services: Array<{ service: string; commit: string | null; digest: string | null }>;
}

const TTL = 600;
const TIME_TTL = 604_800;
const TIME_ERR_TTL = 60;
const PROBE_MS = 3_000;
const GH = 'https://api.github.com';
const HEX40 = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
/** what an update installs (not the updater itself: that is its own update; bootstrap follows the backend) */
const CORE = ['backend', 'gateway', 'web'] as const;

const commitOrNull = (v: unknown): string | null => (typeof v === 'string' && HEX40.test(v) ? v : null);

/**
 * The commit time (committer date, ISO) of a commit of UPDATE_REPO; null when unknown (no such commit, GitHub not reachable).
 * Cached a week (a commit does not change), a failure for a minute.
 */
export async function commitTime(ctx: Pick<Ctx, 'cfg' | 'kv' | 'fetchImpl'>, sha: string): Promise<string | null> {
  if (!HEX40.test(sha)) return null;
  const repo = ctx.cfg.UPDATE_REPO;
  const key = `update:commit:${repo}:${sha}`;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) {
    try { return (JSON.parse(hit) as { time?: string | null }).time ?? null; } catch { /* asked again */ }
  }
  let time: string | null = null;
  try {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'friendflix' };
    if (ctx.cfg.GITHUB_TOKEN) headers.authorization = `Bearer ${ctx.cfg.GITHUB_TOKEN}`;
    const r = await ctx.fetchImpl(`${GH}/repos/${repo}/commits/${sha}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const d = ((await r.json()) as { commit?: { committer?: { date?: unknown } } } | null)?.commit?.committer?.date;
      time = typeof d === 'string' && ISO.test(d) ? d : null;
    } else void r.body?.cancel().catch(() => undefined);
  } catch { /* unknown */ }
  await ctx.kv.set(key, JSON.stringify({ time }), time ? TIME_TTL : TIME_ERR_TTL).catch(() => undefined);
  return time;
}

/** GET a service's JSON within the probe time; null when it does not answer as expected */
async function probe(ctx: Ctx, url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(PROBE_MS), redirect: 'error' });
    if (!r.ok) { void r.body?.cancel().catch(() => undefined); return null; }
    const j = (await r.json()) as unknown;
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** the services as the updater lists them: the core always (missing = unknown), livetv when listed; null without a listing */
async function fromUpdater(ctx: Ctx, own: string): Promise<InstalledBuild['services'] | null> {
  const v = await updaterView(ctx).catch(() => null);
  const listed = v && 'status' in v ? v.status.services : [];
  if (!listed.length) return null;
  const at = (name: string) => listed.find((s) => s.service === name);
  const livetv = at('livetv');
  return [...CORE.map((name) => {
    const s = at(name);
    return { service: name, commit: s?.commit ?? (name === 'backend' ? own : null), digest: s?.digest ?? null };
  }), ...(livetv ? [{ service: 'livetv', commit: livetv.commit, digest: livetv.digest }] : [])];
}

/** the services asked directly (each within 3 s): web names its build in /_app/version.json, the gateway in /health; livetv when installed */
async function fromProbes(ctx: Ctx, own: string): Promise<InstalledBuild['services']> {
  const trim = (u: string) => u.replace(/\/+$/, '');
  const [web, gateway, livetv] = await Promise.all([
    probe(ctx, `${trim(ctx.cfg.WEB_INTERNAL_URL)}/_app/version.json`),
    probe(ctx, `${trim(ctx.cfg.GATEWAY_URL)}/health`),
    detectLivetv(ctx).catch(() => null),
  ]);
  return [
    { service: 'backend', commit: own, digest: null },
    { service: 'gateway', commit: commitOrNull(gateway?.image), digest: null },
    { service: 'web', commit: commitOrNull(web?.version), digest: null },
    ...(livetv?.installed ? [{ service: 'livetv', commit: commitOrNull(livetv.image), digest: null }] : []),
  ];
}

async function compute(ctx: Ctx, own: string): Promise<InstalledBuild> {
  const listed = await fromUpdater(ctx, own);
  const services = listed ?? await fromProbes(ctx, own);
  const source = listed ? 'updater' : 'probes';
  const commits = [...new Set(services.map((s) => s.commit))];
  const times = commits.every((c) => c !== null && HEX40.test(c)) ? await Promise.all(commits.map((c) => commitTime(ctx, c!))) : null;
  if (!times || times.some((t) => t === null)) return { commit: own, time: await commitTime(ctx, own), source: 'self', services };
  let newest = 0;
  times.forEach((t, i) => { if (Date.parse(t!) > Date.parse(times[newest]!)) newest = i; });
  return { commit: commits[newest]!, time: times[newest]!, source, services };
}

function parse(raw: string | null, own: string): InstalledBuild | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as InstalledBuild;
    // a build cached before this backend was recreated on another image is not this one's
    const backend = b.services?.find((s) => s.service === 'backend');
    return typeof b.commit === 'string' && Array.isArray(b.services) && backend?.commit === own ? b : null;
  } catch {
    return null;
  }
}

const cacheKey = (cfg: Ctx['cfg']) => `update:installed:${cfg.UPDATE_REPO}`;
/** the installed build from the cache only (no request); null when nothing is cached */
async function cachedInstalled(ctx: Pick<Ctx, 'kv' | 'cfg'>): Promise<InstalledBuild | null> {
  return parse(await ctx.kv.get(cacheKey(ctx.cfg)).catch(() => null), imageCommit(ctx.cfg));
}

const inflight = new WeakMap<object, Promise<InstalledBuild>>();

/**
 * The installed build (see InstalledBuild), cached in the kv store; `fresh` asks again (and stores the answer). A local build
 * (no 40-hex image commit) is its own installed build: nothing is asked.
 */
export async function installedBuild(ctx: Ctx, opts: { fresh?: boolean } = {}): Promise<InstalledBuild> {
  const own = imageCommit(ctx.cfg);
  if (!HEX40.test(own)) return { commit: own, time: null, source: 'self', services: [{ service: 'backend', commit: own, digest: null }] };
  if (!opts.fresh) {
    const hit = await cachedInstalled(ctx);
    if (hit) return hit;
  }
  const running = inflight.get(ctx);
  if (running) return running;
  const p = (async () => {
    try {
      const b = await compute(ctx, own);
      await ctx.kv.set(cacheKey(ctx.cfg), JSON.stringify(b), TTL).catch(() => undefined);
      return b;
    } finally {
      inflight.delete(ctx);
    }
  })();
  inflight.set(ctx, p);
  return p;
}
