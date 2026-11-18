// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { readFileSync } from 'node:fs';
import { makeEnv, type TestEnv } from './helpers.js';
import { REDEPLOY_KEY, REDEPLOY_LOCK } from '../src/redeploy.js';
import { portainerMode, portainerSetup } from '../src/updates.js';

const VERSION_JSON = JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf8')) as { version: string; codename: string };

const CUR = 'c'.repeat(40);
const NEW = 'd'.repeat(40);
/** a web image built after the backend's (the backend carried) */
const WEB = 'e'.repeat(40);
const HOOK = 'https://portainer.example.com/api/stacks/webhooks/secret-token-uuid';
const KEY = 'ptr_supersecretkey';

interface Seen { method: string; url: string; headers: Record<string, string>; body: any; redirect?: RequestRedirect }
let env: TestEnv;
let seen: Seen[];
let stack: any;
/** Portainer answers every call with a 301 to another origin */
let redirect = false;
/** the body of Portainer's answer to the redeploy PUT (null: 204 without a body) */
let putAnswer: unknown = null;
/** GitHub releases/latest answer; null = no release published (404) */
let release: any;
/** commit times as GitHub answers them (GET /repos/{repo}/commits/{sha}); missing: 404 */
let times: Record<string, string>;
/** what the web service's /_app/version.json names (null: 404) */
let webVersion: string | null;
const host = (u: string) => new URL(u).host;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const mockFetch = (gh: 'ok' | 'fail' = 'ok') => vi.fn(async (input: any, init: RequestInit = {}) => {
  const url = String(input);
  seen.push({ method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect });
  if (host(url) === 'api.github.com') {
    if (gh === 'fail') return json({}, 500);
    if (url.endsWith('/releases/latest')) return release ? json(release) : json({ message: 'Not Found' }, 404);
    if (url.includes('/actions/workflows/ci.yml/runs')) return json({ workflow_runs: [{ head_sha: NEW, updated_at: '2026-01-02T00:00:00Z', html_url: 'https://github.com/x/runs/1' }] });
    if (url.includes(`/compare/${CUR}...${NEW}`)) return json({ ahead_by: 2, commits: [1, 2].map((n) => ({ sha: `s${n}`, html_url: `https://github.com/c/${n}`, commit: { message: `msg ${n}\n\nbody`, author: { name: 'Ann', date: '2026-01-01T00:00:00Z' } } })) });
    if (url.includes(`/compare/${WEB}...${NEW}`)) return json({ ahead_by: 1, commits: [] });
    const commit = /\/commits\/([0-9a-f]{40})$/.exec(url)?.[1];
    if (commit && times[commit]) return json({ sha: commit, commit: { committer: { date: times[commit] } } });
  }
  if (host(url) === 'web:3000' && url.endsWith('/_app/version.json')) return webVersion ? json({ version: webVersion }) : json({}, 404);
  if (host(url) === 'gateway:4000' && url.endsWith('/health')) return json({ status: 'ok', image: CUR });
  if (redirect && host(url) === 'portainer.example.com') return new Response(null, { status: 301, headers: { location: `https://elsewhere.example.net${new URL(url).pathname}` } });
  if (url.endsWith('/api/stacks/7/file')) return json({ StackFileContent: 'services: {}' });
  if (url.includes('/api/stacks/7') && (init.method ?? 'GET') === 'GET') return json(stack);
  if (host(url) === 'portainer.example.com') return putAnswer === null ? new Response(null, { status: 204 }) : json(putAnswer);
  return json({}, 404);
});

async function setup(cfg: Record<string, unknown> = {}, gh: 'ok' | 'fail' = 'ok') {
  env = await makeEnv({}, { ctxPatch: (c: Ctx) => { c.cfg = { ...c.cfg, GIT_SHA: CUR, BUILD_TIME: '2026-01-01T00:00:00Z', ...cfg }; } });
  env.ctx.fetchImpl = mockFetch(gh) as any;
  const admin = await env.login();
  const post = (cookies = admin.cookies, csrf = admin.csrf) => env.app.inject({ method: 'POST', url: '/api/admin/update', cookies, headers: { 'x-csrf-token': csrf } });
  const get = (q = '') => env.app.inject({ url: `/api/admin/update${q}`, cookies: admin.cookies });
  return { admin, post, get };
}
const ghCalls = () => seen.filter((s) => host(s.url) === 'api.github.com').length;

beforeEach(() => { seen = []; release = null; times = { [CUR]: '2026-01-01T00:00:00Z' }; webVersion = null; redirect = false; putAnswer = null; stack = { Env: [{ name: 'A', value: '1' }, { name: 'B', value: 'x y' }], GitConfig: null }; });
afterEach(() => env?.close());

describe('admin update', () => {
  it('combines run and compare, caches, refresh bypasses', async () => {
    const { get } = await setup();
    const r = await get();
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.latest).toEqual({ sha: NEW, date: '2026-01-02T00:00:00Z', runUrl: 'https://github.com/x/runs/1' });
    expect(b.behind).toBe(2);
    expect(b.commits.map((c: any) => c.message)).toEqual(['msg 2', 'msg 1']);
    expect(b.current).toEqual({ sha: CUR, builtAt: '2026-01-01T00:00:00Z', ...VERSION_JSON }); // no APP_VERSION: read from version.json
    expect(b.release).toBeNull();
    expect(b.updateAvailable).toBeNull();
    expect(b.portainer).toEqual({ configured: false, mode: null, missing: [] });
    expect(ghCalls()).toBe(5); // release, CI run, compare, tag commit of the installed version, commit time of the installed build
    await get();
    expect(ghCalls()).toBe(5);
    await get('?refresh=1');
    expect(ghCalls()).toBe(9); // a commit's time stays cached
    expect(b.current.builtAt).toBe('2026-01-01T00:00:00Z'); // the installed build's commit time
    expect(seen.filter((s) => host(s.url) === 'api.github.com').every((s) => s.headers['user-agent'] === 'friendflix')).toBe(true);
  });

  it('behind and builtAt come from the installed build', async () => {
    // web runs a newer image than the backend (the backend was carried): the comparison starts at web's commit, its time is "built at"
    webVersion = WEB; times[WEB] = '2026-01-05T00:00:00Z';
    const { get } = await setup();
    const b = (await get()).json();
    expect(b.current).toMatchObject({ sha: WEB, builtAt: '2026-01-05T00:00:00Z' });
    expect(b.behind).toBe(1);
    expect(seen.some((s) => s.url.includes(`/compare/${WEB}...${NEW}`))).toBe(true);
    expect(seen.some((s) => s.url.includes(`/compare/${CUR}...`))).toBe(false);
    // the GitHub answer is cached under the installed build
    expect(await env.kv.get(`update:info:${env.ctx.cfg.UPDATE_REPO}:${WEB}:${VERSION_JSON.version}`)).not.toBeNull();
  });

  it('the cached release version survives the installed build\'s cache running out', async () => {
    release = rel('v1.1.0');
    webVersion = WEB; times[WEB] = '2026-01-05T00:00:00Z'; // the installed build (web's) is not the backend's own commit
    const { get } = await setup({ APP_VERSION: '1.0.0' });
    expect((await get()).json().current.sha).toBe(WEB);
    const { cachedReleaseVersion } = await import('../src/updates.js');
    expect(await cachedReleaseVersion(env.ctx)).toBe('1.1.0');
    await env.kv.del(`update:installed:${env.ctx.cfg.UPDATE_REPO}`); // its 10 minutes ran out first
    const before = seen.length;
    expect(await cachedReleaseVersion(env.ctx)).toBe('1.1.0');
    expect(seen.length).toBe(before); // still no request
  });

  it('GitHub failure gives latest null, not a 500', async () => {
    const { get } = await setup({}, 'fail');
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ release: null, updateAvailable: null, latest: null, behind: null, commits: [], error: 'GitHub 500' });
  });

  it('dev build returns latest without compare', async () => {
    const { get } = await setup({ GIT_SHA: 'dev' });
    const b = (await get()).json();
    expect(b.latest.sha).toBe(NEW);
    expect(b.commits).toEqual([]);
    expect(ghCalls()).toBe(2);
  });

  const rel = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, name: `${tag} Arancini`, html_url: `https://github.com/x/releases/tag/${tag}`, published_at: '2026-10-01T00:00:00Z', body: '### Neu\n- <b>fett</b> & mehr', draft: false, prerelease: false, ...extra });

  it('release newer than the installed version: update available, notes and codename', async () => {
    release = rel('v1.1.0');
    const { get } = await setup({ APP_VERSION: '1.0.0', APP_CODENAME: 'Arancini' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(true);
    expect(b.release).toEqual({ version: '1.1.0', codename: 'Arancini', tag: 'v1.1.0', name: 'v1.1.0 Arancini', url: 'https://github.com/x/releases/tag/v1.1.0', publishedAt: '2026-10-01T00:00:00Z', notes: '### Neu\n- <b>fett</b> & mehr' });
    expect(b.current).toMatchObject({ version: '1.0.0', codename: 'Arancini', sha: CUR });
    expect(b.behind).toBe(2); // commits ahead stay as secondary info
    expect(seen.some((s) => s.url === 'https://api.github.com/repos/LetsManu/friendflix/releases/latest')).toBe(true);
  });

  it('a new major release carries the next codename', async () => {
    release = rel('v2.0.0');
    const { get } = await setup({ APP_VERSION: '1.4.2' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(true);
    expect(b.release.codename).toBe('Brezel');
    expect(b.current.codename).toBe('Arancini'); // derived from the major when APP_CODENAME is unset
  });

  it('installed version equals the newest release: up to date', async () => {
    release = rel('v1.1.0');
    const { get } = await setup({ APP_VERSION: '1.1.0', APP_CODENAME: 'Arancini' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(false);
    expect(b.release.version).toBe('1.1.0');
  });

  it('no release yet: no release answer, commits ahead decide', async () => {
    const { get } = await setup({ APP_VERSION: '1.0.0' });
    const b = (await get()).json();
    expect(b.release).toBeNull();
    expect(b.updateAvailable).toBeNull();
    expect(b.behind).toBe(2);
    expect(b.error).toBeUndefined();
  });

  it('dev/main build newer than the last release: not an update, main build stays secondary info', async () => {
    release = rel('v1.1.0');
    const { get } = await setup({ GIT_SHA: 'dev', APP_VERSION: '1.2.0' });
    const b = (await get()).json();
    expect(b.updateAvailable).toBe(false);
    expect(b.latest.sha).toBe(NEW);
    expect(b.current).toMatchObject({ sha: 'dev', version: '1.2.0' });
  });

  it('drafts, pre-releases and non-version tags are ignored', async () => {
    release = rel('v9.0.0', { prerelease: true });
    const { get } = await setup({ APP_VERSION: '1.0.0' });
    expect((await get()).json()).toMatchObject({ release: null, updateAvailable: null });
    for (const r of [rel('nightly'), rel('v9.0.0', { draft: true })]) {
      release = r;
      expect((await get('?refresh=1')).json()).toMatchObject({ release: null, updateAvailable: null });
    }
  });

  it('exposes the version unauthenticated', async () => {
    await setup({ APP_VERSION: '1.3.0', APP_CODENAME: 'Arancini' });
    // CUR is no tag commit (the mock answers 404 for the tag): a nightly build
    expect((await env.app.inject('/api/version')).json()).toEqual({ sha: CUR, version: '1.3.0', codename: 'Arancini', build: 'nightly', channel: 'nightly', label: '1.3.0-nightly · ccccccc', minAndroid: '2.0.0', authOrigin: 'https://auth.example.com' });
    expect((await env.app.inject('/health')).json().version).toBe(CUR.slice(0, 7));
  });

  it('/health answers FF_IMAGE_COMMIT[0:7], else GIT_SHA[0:7]', async () => {
    await setup({ FF_IMAGE_COMMIT: 'd'.repeat(40) });
    expect((await env.app.inject('/health')).json()).toEqual({ status: 'ok', version: 'ddddddd' });
    await env.close();
    await setup({ FF_IMAGE_COMMIT: undefined });
    expect((await env.app.inject('/health')).json()).toEqual({ status: 'ok', version: CUR.slice(0, 7) });
    await env.close();
    await setup({ FF_IMAGE_COMMIT: 'dev' }); // not 40 hex: the GIT_SHA of older images stands in
    expect((await env.app.inject('/health')).json().version).toBe(CUR.slice(0, 7));
  });

  it('not configured -> 409', async () => {
    const { post } = await setup();
    expect((await post()).statusCode).toBe(409);
  });

  it('non-admins get 403', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'u1','u@example.com','U','friend','jfu','u','x')");
    const u = await env.login({ sub: 'u1', email: 'u@example.com', name: 'U', groups: [] });
    expect((await post(u.cookies, u.csrf)).statusCode).toBe(403);
    expect((await env.app.inject({ url: '/api/admin/update', cookies: u.cookies })).statusCode).toBe(403);
  });

  it('"reload anyway": POST { force: true } records a forced redeploy (audited); no body (an older page) is not forced', async () => {
    const { admin } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    const r = await env.app.inject({ method: 'POST', url: '/api/admin/update', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { force: true } });
    expect(r.statusCode).toBe(202);
    expect(JSON.parse((await env.kv.get(REDEPLOY_KEY))!)).toMatchObject({ v: 1, forced: true });
    const a = await env.pool.query("select meta from audit_log where action='system.update'");
    expect(a.rows[0].meta).toMatchObject({ forced: true });
    await env.kv.del(REDEPLOY_LOCK); await env.kv.del(REDEPLOY_KEY);
    const { redeployViaPortainer } = await import('../src/updates.js');
    expect((await redeployViaPortainer(env.ctx, null, 'webhook')).ok).toBe(true);
    expect(JSON.parse((await env.kv.get(REDEPLOY_KEY))!).forced).toBeUndefined();
  });

  it('webhook mode posts to the URL, audits, and leaks no secret', async () => {
    const { post, get } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    const g = await get();
    expect(g.json().portainer).toEqual({ configured: true, mode: 'webhook', missing: [] });
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true, mode: 'webhook' });
    // the selected channel rides along as a stack variable (stable = latest)
    const hook = seen.find((s) => s.url === `${HOOK}?FF_TAG=latest`)!;
    expect(hook.method).toBe('POST');
    expect(hook.body).toBeUndefined();
    const a = await env.pool.query("select actor, meta from audit_log where action='system.update'");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].meta).toMatchObject({ from: CUR, to: NEW });
    for (const t of [g.body, r.body, JSON.stringify(a.rows)]) expect(t).not.toContain('secret-token');
  });

  it('portainer error -> 502 with status only', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    (env.ctx.fetchImpl as any) = vi.fn(async () => new Response(null, { status: 500 }));
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'portainer', status: 500, step: 'webhook' });
    expect(r.body).not.toContain('secret-token');
  });

  it('a webhook answering 404 (the token is stale: Portainer issues a new one when the stack is recreated) -> its own code, no URL', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    (env.ctx.fetchImpl as any) = vi.fn(async () => new Response(null, { status: 404 }));
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'webhook_gone', status: 404, step: 'webhook' });
    expect(r.body).not.toContain('secret-token');
    const rec = JSON.parse((await env.ctx.kv.get(REDEPLOY_KEY))!);
    expect(rec).toMatchObject({ final: 'failed', error: 'webhook_gone', step: 'webhook', status: 404 });
  });

  it('an API 404 (unknown stack) stays a plain portainer refusal', async () => {
    const { post } = await setup({ PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: KEY, PORTAINER_STACK_ID: '7' });
    (env.ctx.fetchImpl as any) = vi.fn(async () => new Response(null, { status: 404 }));
    const r = await post();
    expect(r.json()).toEqual({ error: 'portainer', status: 404, step: 'stack' });
  });

  it('portainerMode: the API way wins when it is complete, the webhook only stands alone', async () => {
    await setup();
    const api = { PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: KEY, PORTAINER_STACK_ID: '7' };
    const at = (c: Record<string, unknown>) => ({ ...env.ctx, cfg: { ...env.ctx.cfg, PORTAINER_WEBHOOK_URL: '', PORTAINER_URL: '', PORTAINER_API_KEY: '', PORTAINER_STACK_ID: '', ...c } }) as Ctx;
    expect(portainerMode(at({ ...api, PORTAINER_WEBHOOK_URL: HOOK }))).toBe('api');
    expect(portainerSetup(at({ ...api, PORTAINER_WEBHOOK_URL: HOOK }))).toEqual({ configured: true, mode: 'api', missing: [] });
    expect(portainerMode(at({ PORTAINER_WEBHOOK_URL: HOOK }))).toBe('webhook');
    expect(portainerMode(at({ PORTAINER_WEBHOOK_URL: HOOK, PORTAINER_URL: api.PORTAINER_URL }))).toBe('webhook'); // API only in part
    expect(portainerMode(at(api))).toBe('api');
    expect(portainerMode(at({}))).toBeNull();
  });

  it('both ways set: Update now goes through the API, the (stale) webhook is never called', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK, PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: KEY, PORTAINER_STACK_ID: '7' });
    const r = await post();
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ ok: true, mode: 'api' });
    expect(seen.some((s) => s.url.includes('/webhooks/'))).toBe(false);
  });

  it('unreachable portainer -> 502 with the errno code only, never the URL', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    (env.ctx.fetchImpl as any) = vi.fn(async (url: string) => { throw Object.assign(new TypeError(`fetch failed ${url}`), { cause: { code: 'ENOTFOUND', hostname: url } }); });
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'portainer_unreachable', status: null, step: 'webhook', code: 'ENOTFOUND' });
    expect(r.body).not.toContain('secret-token');
  });

  it('unreachable portainer -> 502 with the errno code only, never the URL', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    (env.ctx.fetchImpl as any) = vi.fn(async (url: string) => { throw Object.assign(new TypeError(`fetch failed ${url}`), { cause: { code: 'ENOTFOUND', hostname: url } }); });
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'portainer_unreachable', status: null, step: 'webhook', code: 'ENOTFOUND' });
    expect(r.body).not.toContain('secret-token');
  });

  const api = { PORTAINER_URL: 'https://portainer.example.com/', PORTAINER_API_KEY: KEY, PORTAINER_STACK_ID: '7', PORTAINER_ENDPOINT_ID: 3 };

  it('api mode, git stack: git/redeploy with pullImage and preserved env', async () => {
    stack.GitConfig = { ReferenceName: 'refs/heads/main' };
    const { post, get } = await setup(api);
    const g = await get();
    const r = await post();
    expect(r.statusCode).toBe(202);
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.url).toBe('https://portainer.example.com/api/stacks/7/git/redeploy?endpointId=3');
    expect(put.headers['x-api-key']).toBe(KEY);
    expect(put.body).toMatchObject({ pullImage: true, prune: false, env: [...stack.Env, { name: 'FF_TAG', value: 'latest' }], repositoryReferenceName: 'refs/heads/main' });
    expect(g.body + r.body).not.toContain(KEY);
  });

  it('api mode, file stack: stackFileContent and env', async () => {
    const { post } = await setup(api);
    expect((await post()).statusCode).toBe(202);
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.url).toBe('https://portainer.example.com/api/stacks/7?endpointId=3');
    expect(put.body).toMatchObject({ stackFileContent: 'services: {}', env: [...stack.Env, { name: 'FF_TAG', value: 'latest' }], pullImage: true, prune: false });
  });

  it('api mode redeploys on the stack\'s own environment: Portainer moves a stack to whatever endpointId is named', async () => {
    stack.EndpointId = 2;
    const { post } = await setup(api); // PORTAINER_ENDPOINT_ID 3 (or the default 1) would move the stack to another environment
    expect((await post()).statusCode).toBe(202);
    expect(seen.find((s) => s.method === 'PUT')!.url).toBe('https://portainer.example.com/api/stacks/7?endpointId=2');
  });

  it('a redirect from Portainer (e.g. to another origin) is never followed: the key and the webhook token stay with the host entered', async () => {
    redirect = true;
    const a = await setup(api);
    const r = await a.post();
    expect([r.statusCode, r.json()]).toEqual([502, { error: 'portainer', status: 301, step: 'stack' }]);
    expect(seen.filter((s) => host(s.url).startsWith('portainer')).map((s) => [host(s.url), s.redirect])).toEqual([['portainer.example.com', 'manual']]);
    expect(seen.some((s) => host(s.url) === 'elsewhere.example.net')).toBe(false);
    await env.close(); seen = [];
    const w = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    expect((await w.post()).json()).toMatchObject({ error: 'portainer', status: 301, step: 'webhook' });
    expect(seen.filter((s) => host(s.url).startsWith('portainer')).map((s) => s.redirect)).toEqual(['manual']);
  });

  it('api mode, git stack with stored credentials: authentication on with the stored user and an empty password (Portainer keeps the stored one)', async () => {
    stack.GitConfig = { ReferenceName: 'refs/heads/main', Authentication: { Username: 'deploy-bot', Password: '' } };
    const { post } = await setup(api);
    expect((await post()).statusCode).toBe(202);
    expect(seen.find((s) => s.method === 'PUT')!.body).toMatchObject({ repositoryAuthentication: true, repositoryUsername: 'deploy-bot', repositoryPassword: '' });
  });

  it('api mode, git stack with an empty Authentication (no user name: nothing stored to keep): no authentication fields sent', async () => {
    stack.GitConfig = { ReferenceName: 'refs/heads/main', Authentication: {} };
    const { post } = await setup(api);
    expect((await post()).statusCode).toBe(202);
    const body = seen.find((s) => s.method === 'PUT')!.body;
    expect(body).not.toHaveProperty('repositoryAuthentication');
    expect(body).not.toHaveProperty('repositoryUsername');
    expect(body).not.toHaveProperty('repositoryPassword');
  });

  it('one redeploy at a time: a second POST while one runs is refused (busy) and nothing is sent', async () => {
    putAnswer = { Id: 7, Status: 3 }; // Portainer from 2.36: answers at once, still deploying
    const { post, admin } = await setup(api);
    expect((await post()).statusCode).toBe(202);
    const rec = await env.kv.get(REDEPLOY_KEY);
    // the API answered "deploying": the page keeps waiting (no "unchanged" yet)
    expect((await env.app.inject({ url: '/api/admin/updater', cookies: admin.cookies })).json().redeploy).toMatchObject({ phase: 'pulling', running: true });
    const puts = seen.filter((s) => s.method === 'PUT').length;
    // a second admin (the rate limit is per portal, so a fresh app with the same stored redeploy)
    await env.close();
    const again = await setup(api);
    await env.kv.set(REDEPLOY_KEY, rec!, 3600);
    await env.kv.set(REDEPLOY_LOCK, JSON.parse(rec!).id, 3600);
    const r = await again.post();
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'busy' }]);
    expect(seen.filter((s) => s.method === 'PUT').length).toBe(puts);
    expect(await env.kv.get(REDEPLOY_KEY)).toBe(rec);
  });

  it('api mode answered "done" (Portainer before 2.36: redeploys, then answers) and nothing changed: unchanged at once', async () => {
    putAnswer = { Id: 7, Status: 1 };
    const { post, admin } = await setup(api);
    expect((await post()).statusCode).toBe(202);
    expect((await env.app.inject({ url: '/api/admin/updater', cookies: admin.cookies })).json().redeploy).toMatchObject({ phase: 'unchanged', running: false });
  });

  it('api mode, a 2xx without a readable stack waits (no "unchanged" from it); a stack in error (Status 4) is a refusal at step deploy', async () => {
    const { post, admin } = await setup(api); // PUT answers 204 without a body
    expect((await post()).statusCode).toBe(202);
    expect((await env.app.inject({ url: '/api/admin/updater', cookies: admin.cookies })).json().redeploy).toMatchObject({ phase: 'pulling', running: true });
    await env.close(); seen = [];
    putAnswer = { Id: 7, Status: 4 };
    const bad = await setup(api);
    const r = await bad.post();
    expect([r.statusCode, r.json()]).toEqual([502, { error: 'portainer', status: null, step: 'deploy' }]);
    expect((await env.app.inject({ url: '/api/admin/updater', cookies: bad.admin.cookies })).json().redeploy).toMatchObject({ phase: 'failed', step: 'deploy', status: null });
    expect(await env.kv.get(REDEPLOY_LOCK)).toBeNull();
  });

  it('a redeploy that cannot be recorded (the store\'s mutex taken) is refused before anything is sent, and the slot is free again', { timeout: 15_000 }, async () => {
    const { post } = await setup(api);
    await env.kv.set('update:portainer:redeploy:mutex', 'someone-else', 60);
    const r = await post();
    expect([r.statusCode, r.json()]).toEqual([503, { error: 'busy' }]);
    expect(seen.filter((s) => s.method === 'PUT')).toHaveLength(0);
    expect(await env.kv.get(REDEPLOY_LOCK)).toBeNull();
    expect(await env.kv.get(REDEPLOY_KEY)).toBeNull();
  });

  it('the slot is given back when the update info or the audit throws before anything is sent', async () => {
    await setup(api);
    const { redeployViaPortainer } = await import('../src/updates.js');
    const broken = { get current(): never { throw new Error('boom'); } } as unknown as Parameters<typeof redeployViaPortainer>[3];
    await expect(redeployViaPortainer(env.ctx, null, 'api', broken)).rejects.toThrow('boom');
    expect(await env.kv.get(REDEPLOY_LOCK)).toBeNull();
    expect(seen.filter((s) => host(s.url) === 'portainer.example.com')).toHaveLength(0);
  });

  it('api set up only in part: GET names the missing settings (never a value), POST refuses as not configured', async () => {
    const { post, get } = await setup({ PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: KEY });
    const g = await get();
    expect(g.json().portainer).toEqual({ configured: false, mode: null, missing: ['PORTAINER_STACK_ID'] });
    expect(g.body).not.toContain(KEY);
    expect((await post()).statusCode).toBe(409);
    expect(seen.filter((s) => host(s.url) === 'portainer.example.com')).toHaveLength(0);
  });

  it('api mode: Portainer answers only after "started" went out; a proxy giving up (504) is no verdict, a refusal (500) ends the redeploy as failed', { timeout: 20_000 }, async () => {
    const { admin } = await setup(api);
    const { redeployViaPortainer } = await import('../src/updates.js');
    const base = env.ctx.fetchImpl;
    let answer!: (r: Response) => void;
    env.ctx.fetchImpl = (async (i: any, init: RequestInit = {}) => (init.method === 'PUT' ? new Promise<Response>((res) => { answer = res; }) : base(i, init))) as typeof fetch;
    const view = async () => (await env.app.inject({ url: '/api/admin/updater', cookies: admin.cookies })).json().redeploy;
    const late = async (status: number) => {
      const r = await redeployViaPortainer(env.ctx, null, 'api');
      expect(r).toEqual({ ok: true, mode: 'api', pending: true }); // no answer within the grace window: started
      answer(new Response('{"message":"compose up failed: secret detail"}', { status }));
      await new Promise((res) => setTimeout(res, 50));
      return view();
    };
    expect(await late(504)).toMatchObject({ phase: 'pulling', running: true, error: null });
    // one redeploy at a time: forget the first (it would end by its timeout) before the second
    await env.kv.del(REDEPLOY_LOCK); await env.kv.del(REDEPLOY_KEY);
    const v = await late(500);
    expect(v).toMatchObject({ phase: 'failed', running: false, error: 'portainer', step: 'redeploy', status: 500, at: 'pulling' }); // Portainer was at work: not "refused before anything ran"
    expect(JSON.stringify(v)).not.toContain('secret detail');
    const a = await env.pool.query("select meta from audit_log where action='system.update_result' order by id");
    expect(a.rows.at(-1).meta).toMatchObject({ result: 'failed', late: true, status: 500, step: 'redeploy' });
    expect(JSON.stringify(a.rows)).not.toContain(KEY);
  });

  it('nightly channel: webhook gets ?FF_TAG=nightly (existing query kept), the token never leaks', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: `${HOOK}?pullimage=true`, UPDATE_CHANNEL: 'nightly' });
    expect((await post()).statusCode).toBe(202);
    const hook = seen.find((s) => host(s.url) === 'portainer.example.com')!;
    const u = new URL(hook.url);
    expect(u.searchParams.get('FF_TAG')).toBe('nightly');
    expect(u.searchParams.get('pullimage')).toBe('true');
    const a = await env.pool.query("select meta from audit_log where action='system.update'");
    expect(a.rows[0].meta).toMatchObject({ tag: 'nightly', mode: 'webhook' });
    expect(JSON.stringify(a.rows)).not.toContain('secret-token');
  });

  it('api mode replaces an existing FF_TAG in place and keeps every other variable', async () => {
    stack.Env = [{ name: 'A', value: '1' }, { name: 'FF_TAG', value: 'latest' }, { name: 'B', value: 'x y' }];
    const { post } = await setup({ ...api, UPDATE_CHANNEL: 'nightly' });
    expect((await post()).statusCode).toBe(202);
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.body.env).toEqual([{ name: 'A', value: '1' }, { name: 'FF_TAG', value: 'nightly' }, { name: 'B', value: 'x y' }]);
  });

  it('pinned channel sends the version; pinned without a version starts nothing', async () => {
    const pinned = await setup({ ...api, UPDATE_CHANNEL: 'pinned', UPDATE_VERSION: '2.4.1' });
    expect((await pinned.post()).statusCode).toBe(202);
    expect(seen.find((s) => s.method === 'PUT')!.body.env).toContainEqual({ name: 'FF_TAG', value: '2.4.1' });
    await env.close(); seen = [];
    const bare = await setup({ ...api, UPDATE_CHANNEL: 'pinned' });
    const r = await bare.post();
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'no_target' });
    expect(seen.filter((s) => host(s.url) === 'portainer.example.com')).toHaveLength(0);
  });

  it('rate limit: second POST within 2 minutes -> 429', async () => {
    const { post } = await setup({ PORTAINER_WEBHOOK_URL: HOOK });
    expect((await post()).statusCode).toBe(202);
    expect((await post()).statusCode).toBe(429);
  });
});
