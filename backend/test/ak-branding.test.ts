// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readBrand, resetBrand, saveBrand, storeImage } from '../src/brand/repo.js';
import { akFlowCacheKey } from '../src/authentik.js';
import type { Config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { sessionKey } from '../src/session.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Mail stage C, Task 6: *Branding an Authentik übertragen* (Controller's calls 8 and 9). A recording fake of Authentik's admin API;
// the SMTP password may reach exactly one request (the e-mail stage PATCH, with consent and a fresh sign-in) and nothing else.
type Sess = { cookies: Record<string, string>; csrf: string };
interface AkReq { method: string; path: string; body: string | null }

// built from pieces at run time (gitleaks)
const TOKEN = ['ak', 'fixture', 'service', '7731'].join('-');
const PASS = ['hunter2', 'fixture'].join('-');
const FROM = 'kino@friend.example.com';
const FRIEND = { sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] as string[] };
const LOGO_HASH = createHash('sha256').update('nordlicht-logo').digest('hex');
const SYMBOL_HASH = createHash('sha256').update('nordlicht-symbol').digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const AK: Partial<Config> = {
  AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: TOKEN, OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/',
  PUBLIC_URL: 'https://friend.example.com',
};
const MAIL: Partial<Config> = {
  MAIL_SMTP_HOST: 'mail.example.com', MAIL_SMTP_PORT: 587, MAIL_SMTP_TLS: 'starttls', MAIL_SMTP_USER: 'kino', MAIL_SMTP_PASSWORD: PASS, MAIL_FROM: FROM,
};

/** Authentik as the fake answers it; each test changes what it needs */
interface AkWorld {
  brands: Array<{ brand_uuid: string; domain: string; default: boolean }>;
  /** status (and `detail`) of the brand list, the brand PATCH and the stage PATCH; undefined = 200 */
  brandList?: { status: number; detail?: string };
  brandPatch?: { status: number; detail?: string };
  stagePatch?: { status: number; detail?: string };
  stageGet?: { status: number; detail?: string };
  /** the bindings read (status), undefined = 200 */
  bindingsList?: { status: number; detail?: string };
  /** the stage uses Authentik's global e-mail settings (its own from_address is then ignored) */
  stageGlobal: boolean;
  /** stage pks that answer 404 (deleted in Authentik) */
  goneStages: string[];
  /** the recovery flow's bindings */
  bindings: Array<{ order: number; stage: string; stage_obj: { meta_model_name: string } }>;
  /** every call answers 403 "Token invalid/expired" */
  tokenBad: boolean;
  /** every call fails before an answer (connection refused) */
  down: boolean;
}
const world = (): AkWorld => ({
  brands: [{ brand_uuid: 'b-default', domain: 'authentik-default', default: true }, { brand_uuid: 'b-1', domain: 'auth.example.com', default: false }],
  bindings: [
    { order: 10, stage: 'ident-1', stage_obj: { meta_model_name: 'authentik_stages_identification.identificationstage' } },
    { order: 20, stage: 's-1', stage_obj: { meta_model_name: 'authentik_stages_email.emailstage' } },
  ],
  stageGlobal: false, goneStages: [], tokenBad: false, down: false,
});

describe('Branding an Authentik übertragen', () => {
  let env: TestEnv;
  let admin: Sess, friend: Sess;
  let adminId: string;
  let ak = world();
  const calls: AkReq[] = [];
  const logs: string[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init.body ? String(init.body) : null });
    if (ak.down) throw new TypeError('fetch failed');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const answer = (o: { status: number; detail?: string } | undefined, ok: unknown) =>
      o ? json(o.status, { detail: o.detail ?? 'You do not have permission to perform this action.' }) : json(200, ok);
    if (ak.tokenBad) return json(403, { detail: 'Token invalid/expired' });
    const p = url.pathname;
    if (method === 'GET' && p === '/api/v3/core/brands/') return answer(ak.brandList, { pagination: { next: 0 }, results: ak.brands });
    if (method === 'PATCH' && /^\/api\/v3\/core\/brands\/[^/]+\/$/.test(p)) return answer(ak.brandPatch, {});
    if (method === 'GET' && p === '/api/v3/flows/instances/default-recovery-flow/') return json(200, { pk: 'flow-1', slug: 'default-recovery-flow' });
    if (method === 'GET' && p === '/api/v3/flows/bindings/') return answer(ak.bindingsList, { pagination: { next: 0 }, results: url.searchParams.get('target') === 'flow-1' ? ak.bindings : [] });
    const stage = /^\/api\/v3\/stages\/email\/([^/]+)\/$/.exec(p)?.[1];
    if (stage && ak.goneStages.includes(stage)) return json(404, { detail: 'Not found.' });
    if (method === 'GET' && stage) return answer(ak.stageGet, { pk: stage, name: 'default-recovery-email', use_global_settings: ak.stageGlobal });
    if (method === 'PATCH' && stage) return answer(ak.stagePatch, { pk: stage, use_global_settings: false });
    return json(404, { detail: 'Not found.' });
  }) as typeof fetch;

  let n = 0;
  const as = (s: Sess, method: 'GET' | 'POST', payload?: unknown) => env.app.inject({
    method, url: '/api/admin/authentik/branding', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf },
    remoteAddress: `192.0.2.${(n = (n % 200) + 1)}`, ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const post = (smtp: boolean) => as(admin, 'POST', { smtp });
  const stale = async (s: Sess) => {
    const key = sessionKey(s.cookies.ff_sid!);
    await env.kv.set(key, JSON.stringify({ ...JSON.parse((await env.kv.get(key))!), reauthAt: Date.now() - 20 * 60_000 }), 600);
  };
  const fresh = async (s: Sess) => {
    const key = sessionKey(s.cookies.ff_sid!);
    await env.kv.set(key, JSON.stringify({ ...JSON.parse((await env.kv.get(key))!), reauthAt: Date.now() }), 600);
  };
  const patches = (re: RegExp) => calls.filter((c) => c.method === 'PATCH' && re.test(c.path));
  const bodyOf = (c: AkReq | undefined) => (c?.body ? JSON.parse(c.body) as Record<string, unknown> : undefined);
  const setBrand = async (patch: Record<string, unknown>) => { await saveBrand(env.ctx.db, adminId, (await readBrand(env.ctx.db)).rev, patch); };
  const auditRows = async () => (await env.pool.query<{ meta: Record<string, unknown> }>("select meta from audit_log where action = 'authentik.branding' order by id")).rows.map((r) => r.meta);

  beforeAll(async () => {
    env = await makeEnv({}, {
      ctxPatch: (c) => { c.fetchImpl = fakeFetch; },
      logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' },
    });
    admin = await env.login(ADMIN);
    adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-ben','ben@friend.example.com','Ben Muster','friend','jfben','Ben',$1)", [encrypt(env.ctx.encKey, 'pw')]);
    friend = await env.login(FRIEND);
  });
  afterAll(() => env.close());
  beforeEach(async () => {
    ak = world();
    calls.length = 0;
    env.ctx.cfg = { ...cfg, ...AK, ...MAIL };
    await env.kv.del(akFlowCacheKey(env.ctx.cfg, 'default-recovery-flow'));
    await env.kv.del('akdiag:last:api');
    await env.pool.query("delete from audit_log where action = 'authentik.branding'");
    await resetBrand(env.ctx.db, adminId, (await readBrand(env.ctx.db)).rev);
    // stored again before each test: the clean-up test deletes images
    await storeImage(env.ctx.db, { bytes: PNG, mime: 'image/png', width: 1024, height: 256, hash: LOGO_HASH });
    await storeImage(env.ctx.db, { bytes: Buffer.concat([PNG, Buffer.from([9])]), mime: 'image/png', width: 512, height: 512, hash: SYMBOL_HASH });
    await setBrand({ name: 'Nordlicht TV', logo: LOGO_HASH });
    await fresh(admin);
  });
  afterEach(() => { env.ctx.cfg = cfg; });

  const LOGO_URL = `https://friend.example.com/api/public/brand/img/${LOGO_HASH}.png`;

  it('without consent no request carries a password', async () => {
    const r = await post(false);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'done' } });
    const brand = patches(/\/core\/brands\//);
    expect(brand.map((c) => c.path)).toEqual(['/api/v3/core/brands/b-1/']);
    expect(bodyOf(brand[0])).toEqual({ branding_title: 'Nordlicht TV', branding_logo: LOGO_URL });
    const stage = patches(/\/stages\/email\//);
    expect(stage.map((c) => c.path)).toEqual(['/api/v3/stages/email/s-1/']);
    // Authentik's from_address is an e-mail field (2026.8.3: models.EmailField, schema format: email): the bare address
    expect(bodyOf(stage[0])).toEqual({ from_address: FROM });
    for (const c of calls) {
      expect(c.body ?? '').not.toContain('password');
      expect(c.body ?? '').not.toContain(PASS);
    }
    expect(await auditRows()).toEqual([{ smtp: false, brand: 'done', stage: 'done' }]);
  });

  it('with consent only the stage PATCH carries it', async () => {
    const r = await post(true);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'done' } });
    const stage = patches(/\/stages\/email\//);
    expect(bodyOf(stage[0])).toEqual({
      from_address: FROM, use_global_settings: false, host: 'mail.example.com', port: 587, username: 'kino', password: PASS, use_tls: true, use_ssl: false, timeout: 10,
    });
    expect(calls.filter((c) => (c.body ?? '').includes(PASS))).toEqual([stage[0]]);
    expect(r.body).not.toContain(PASS);
    const audits = await auditRows();
    expect(audits).toEqual([{ smtp: true, brand: 'done', stage: 'done' }]);
    expect((await env.pool.query('select meta::text as m from audit_log')).rows.map((x: { m: string }) => x.m).join('\n')).not.toContain(PASS);
    // every kv value (sessions, caches, akdiag:last:api) and every log line
    const kv = (env.kv as unknown as { m: Map<string, { v: string }> }).m;
    for (const [k, v] of kv) expect(`${k}=${v.v}`).not.toContain(PASS);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(PASS);
  });

  it('a refused stage PATCH with consent keeps the password out of kv, logs and the answer', async () => {
    ak.stagePatch = { status: 400, detail: 'invalid' };
    const r = await post(true);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'failed', code: 'error' } });
    expect(r.body).not.toContain(PASS);
    expect(await env.kv.get('akdiag:last:api')).not.toBeNull();
    const kv = (env.kv as unknown as { m: Map<string, { v: string }> }).m;
    for (const [k, v] of kv) expect(`${k}=${v.v}`).not.toContain(PASS);
    for (const line of logs) expect(line).not.toContain(PASS);
  });

  it('consent without a fresh sign-in answers 401 and calls nothing', async () => {
    await stale(admin);
    const r = await post(true);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'reauth_required' });
    expect(calls).toEqual([]);
    expect(await auditRows()).toEqual([]);
    // without consent the sign-in may be old
    expect((await post(false)).statusCode).toBe(200);
  });

  it('consent without mail set up answers mail_not_configured', async () => {
    env.ctx.cfg = { ...cfg, ...AK };
    const r = await post(true);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'mail_not_configured' });
    expect(calls).toEqual([]);
  });

  it('tls none sends no credentials', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_SMTP_TLS: 'none', MAIL_SMTP_PORT: 25 };
    await post(true);
    expect(bodyOf(patches(/\/stages\/email\//)[0])).toMatchObject({ port: 25, username: '', password: '', use_tls: false, use_ssl: false });
    expect(calls.some((c) => (c.body ?? '').includes(PASS))).toBe(false);
  });

  it('tls sends use_ssl', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_SMTP_TLS: 'tls', MAIL_SMTP_PORT: 465 };
    await post(true);
    expect(bodyOf(patches(/\/stages\/email\//)[0])).toMatchObject({ port: 465, username: 'kino', password: PASS, use_tls: false, use_ssl: true });
  });

  it('a bracketed IPv6 host goes to Authentik without the brackets; no user sends empty credentials', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_SMTP_HOST: '[2001:db8::25]', MAIL_SMTP_USER: undefined, MAIL_SMTP_PASSWORD: undefined };
    await post(true);
    expect(bodyOf(patches(/\/stages\/email\//)[0])).toMatchObject({ host: '2001:db8::25', username: '', password: '' });
  });

  it('brand refused, stage done', async () => {
    ak.brandPatch = { status: 403 };
    const r = await post(false);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ brand: { state: 'failed', code: 'permission', permission: 'authentik_brands.change_brand' }, stage: { state: 'done' } });
    expect(patches(/\/stages\/email\//)).toHaveLength(1);
    expect(await auditRows()).toEqual([{ smtp: false, brand: 'failed:permission', stage: 'done' }]);
  });

  it('a brand list the token may not read names view_brand', async () => {
    ak.brandList = { status: 403 };
    const r = await post(false);
    expect(r.json()).toEqual({ brand: { state: 'failed', code: 'permission', permission: 'authentik_brands.view_brand' }, stage: { state: 'done' } });
    expect(patches(/\/core\/brands\//)).toHaveLength(0);
  });

  it('stage refused names change_emailstage', async () => {
    ak.stagePatch = { status: 403 };
    const r = await post(false);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'failed', code: 'permission', permission: 'authentik_stages_email.change_emailstage' } });
  });

  it('a rejected token answers token_invalid for both', async () => {
    ak.tokenBad = true;
    const r = await post(false);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ brand: { state: 'failed', code: 'token_invalid' }, stage: { state: 'failed', code: 'token_invalid' } });
  });

  it('a flow without e-mail stage answers no_email_stage', async () => {
    ak.bindings = ak.bindings.filter((b) => b.stage !== 's-1');
    const r = await post(false);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'failed', code: 'no_email_stage' } });
    expect(patches(/\/stages\/email\//)).toHaveLength(0);
  });

  it('a stage that is gone answers not_found', async () => {
    ak.stagePatch = { status: 404 };
    expect((await post(false)).json()).toMatchObject({ stage: { state: 'failed', code: 'not_found' } });
  });

  it('Authentik down answers unreachable for both', async () => {
    ak.down = true;
    const r = await post(false);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ brand: { state: 'failed', code: 'unreachable' }, stage: { state: 'failed', code: 'unreachable' } });
    expect(await auditRows()).toEqual([{ smtp: false, brand: 'failed:unreachable', stage: 'failed:unreachable' }]);
  });

  it('the default brand is used when no domain matches', async () => {
    ak.brands = ak.brands.filter((b) => b.brand_uuid !== 'b-1');
    await post(false);
    expect(patches(/\/core\/brands\//).map((c) => c.path)).toEqual(['/api/v3/core/brands/b-default/']);
  });

  it('no matching and no default brand answers not_found', async () => {
    ak.brands = [{ brand_uuid: 'b-9', domain: 'other.example.com', default: false }];
    expect((await post(false)).json()).toMatchObject({ brand: { state: 'failed', code: 'not_found' }, stage: { state: 'done' } });
    expect(patches(/\/core\/brands\//)).toHaveLength(0);
  });

  it('the symbol stands in for a missing logo', async () => {
    await setBrand({ logo: null, symbol: SYMBOL_HASH });
    await post(false);
    expect(bodyOf(patches(/\/core\/brands\//)[0])).toEqual({ branding_title: 'Nordlicht TV', branding_logo: `https://friend.example.com/api/public/brand/img/${SYMBOL_HASH}.png` });
  });

  it('no logo and no symbol sends no branding_logo', async () => {
    await setBrand({ logo: null });
    expect((await post(false)).json()).toMatchObject({ brand: { state: 'done', logo: false } });
    expect(bodyOf(patches(/\/core\/brands\//)[0])).toEqual({ branding_title: 'Nordlicht TV' });
  });

  it('no PUBLIC_URL sends the title only', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, PUBLIC_URL: '' };
    expect((await post(false)).json()).toMatchObject({ brand: { state: 'done', logo: false } });
    expect(bodyOf(patches(/\/core\/brands\//)[0])).toEqual({ branding_title: 'Nordlicht TV' });
  });

  it('without a sender and without consent the stage is skipped and not called', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_FROM: undefined };
    const r = await post(false);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'skipped', code: 'nothing_to_send' } });
    expect(calls.filter((c) => /flows|stages/.test(c.path))).toEqual([]);
    expect(await auditRows()).toEqual([{ smtp: false, brand: 'done', stage: 'skipped:nothing_to_send' }]);
  });

  it('a stage on Authentik\'s global settings is not patched without consent: skipped, not done', async () => {
    ak.stageGlobal = true;
    const r = await post(false);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'skipped', code: 'global_settings' } });
    expect(calls.filter((c) => c.path === '/api/v3/stages/email/s-1/').map((c) => c.method)).toEqual(['GET']);
    expect(await auditRows()).toEqual([{ smtp: false, brand: 'done', stage: 'skipped:global_settings' }]);
  });

  it('with consent a stage on global settings gets its own settings (no read needed)', async () => {
    ak.stageGlobal = true;
    const r = await post(true);
    expect(r.json()).toMatchObject({ stage: { state: 'done' } });
    expect(calls.filter((c) => c.path === '/api/v3/stages/email/s-1/').map((c) => c.method)).toEqual(['PATCH']);
    expect(bodyOf(patches(/\/stages\/email\//)[0])).toMatchObject({ use_global_settings: false, from_address: FROM });
  });

  it('a stage read the token may not do names view_emailstage', async () => {
    ak.stageGet = { status: 403 };
    expect((await post(false)).json()).toMatchObject({ stage: { state: 'failed', code: 'permission', permission: 'authentik_stages_email.view_emailstage' } });
    expect(patches(/\/stages\/email\//)).toHaveLength(0);
  });

  it('a refused flow read names its permission', async () => {
    ak.bindingsList = { status: 403 };
    expect((await post(false)).json()).toMatchObject({ stage: { state: 'failed', code: 'permission', permission: 'authentik_flows.view_flowstagebinding' } });
  });

  it('a stale cached stage id is dropped and the stage looked up once more', async () => {
    // a cached flow read that still names a deleted stage
    await env.kv.set(akFlowCacheKey(env.ctx.cfg, 'default-recovery-flow'),
      JSON.stringify({ exists: true, failed: false, stages: [{ pk: 's-old', model: 'authentik_stages_email.emailstage' }] }), 600);
    ak.goneStages = ['s-old'];
    const r = await post(false);
    expect(r.json()).toMatchObject({ stage: { state: 'done' } });
    expect(calls.filter((c) => c.path.startsWith('/api/v3/stages/email/')).map((c) => `${c.method} ${c.path}`))
      .toEqual(['GET /api/v3/stages/email/s-old/', 'GET /api/v3/stages/email/s-1/', 'PATCH /api/v3/stages/email/s-1/']);
  });

  it('with consent and a stale cached stage id the password goes to the stage PATCHes only, and the retry is the write', async () => {
    await env.kv.set(akFlowCacheKey(env.ctx.cfg, 'default-recovery-flow'),
      JSON.stringify({ exists: true, failed: false, stages: [{ pk: 's-old', model: 'authentik_stages_email.emailstage' }] }), 600);
    ak.goneStages = ['s-old'];
    const r = await post(true);
    expect(r.json()).toEqual({ brand: { state: 'done', logo: true }, stage: { state: 'done' } });
    // with consent the stage is not read first: the PATCH to the deleted stage (404, nothing written) carries the same body, then the
    // stage is looked up again and the retried PATCH is the one that applies
    expect(calls.filter((c) => (c.body ?? '').includes(PASS)).map((c) => `${c.method} ${c.path}`))
      .toEqual(['PATCH /api/v3/stages/email/s-old/', 'PATCH /api/v3/stages/email/s-1/']);
    expect(bodyOf(patches(/\/stages\/email\/s-1\//)[0])).toMatchObject({ password: PASS, use_global_settings: false });
    expect(calls.filter((c) => c.method !== 'PATCH').every((c) => c.body === null)).toBe(true);
    expect(r.body).not.toContain(PASS);
    expect((await env.pool.query('select meta::text as m from audit_log')).rows.map((x: { m: string }) => x.m).join('\n')).not.toContain(PASS);
    const kv = (env.kv as unknown as { m: Map<string, { v: string }> }).m;
    for (const [k, v] of kv) expect(`${k}=${v.v}`).not.toContain(PASS);
    for (const line of logs) expect(line).not.toContain(PASS);
  });

  it('the logo Authentik loads stays stored after a logo change, until the next transfer sends another', async () => {
    const NEW_HASH = createHash('sha256').update('nordlicht-logo-2').digest('hex');
    await storeImage(env.ctx.db, { bytes: Buffer.concat([PNG, Buffer.from([7])]), mime: 'image/png', width: 1024, height: 256, hash: NEW_HASH });
    const stored = async () => (await env.pool.query<{ hash: string }>('select hash from brand_images')).rows.map((r) => r.hash);
    /** an hour later a save cleans up the images nothing refers to */
    const cleanUp = async (name: string) => {
      await env.pool.query("update brand_images set created_at = now() - interval '2 hours'");
      await setBrand({ name });
    };
    await post(false); // Authentik now loads LOGO_HASH from FriendFlix
    await setBrand({ logo: NEW_HASH });
    await cleanUp('Nordlicht TV 2');
    expect(await stored()).toContain(LOGO_HASH);
    expect(await stored()).not.toContain(SYMBOL_HASH); // the clean-up did run
    // a refused transfer changes nothing in Authentik: the old logo stays kept
    ak.brandPatch = { status: 403 };
    await post(false);
    await cleanUp('Nordlicht TV 3');
    expect(await stored()).toContain(LOGO_HASH);
    // the next transfer sends the new logo: the old one is let go
    ak.brandPatch = undefined;
    calls.length = 0;
    await post(false);
    expect(bodyOf(patches(/\/core\/brands\//)[0])).toMatchObject({ branding_logo: `https://friend.example.com/api/public/brand/img/${NEW_HASH}.png` });
    await setBrand({ logo: null });
    await cleanUp('Nordlicht TV 4');
    expect(await stored()).toEqual([NEW_HASH]);
  });

  it('a stage that stays gone answers not_found after one retry', async () => {
    ak.goneStages = ['s-1'];
    expect((await post(false)).json()).toMatchObject({ stage: { state: 'failed', code: 'not_found' } });
    expect(calls.filter((c) => c.path === '/api/v3/flows/bindings/')).toHaveLength(2);
    expect(calls.filter((c) => c.path.startsWith('/api/v3/stages/email/'))).toHaveLength(2);
  });

  it('a parent-domain brand is the one Authentik shows, and the longest domain wins', async () => {
    ak.brands = [{ brand_uuid: 'b-default', domain: 'authentik-default', default: true }, { brand_uuid: 'b-parent', domain: 'Example.COM', default: false }];
    await post(false);
    expect(patches(/\/core\/brands\//).map((c) => c.path)).toEqual(['/api/v3/core/brands/b-parent/']);
    calls.length = 0;
    ak.brands = [...ak.brands, { brand_uuid: 'b-1', domain: 'auth.example.com', default: false }, { brand_uuid: 'b-x', domain: 'xample.com', default: false }];
    await post(false);
    expect(patches(/\/core\/brands\//).map((c) => c.path)).toEqual(['/api/v3/core/brands/b-1/']);
  });

  it('an issuer port is part of the match', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, OIDC_ISSUER: 'https://auth.example.com:9443/application/o/friendflix/' };
    ak.brands = [...ak.brands, { brand_uuid: 'b-port', domain: 'auth.example.com:9443', default: false }];
    await post(false);
    expect(patches(/\/core\/brands\//).map((c) => c.path)).toEqual(['/api/v3/core/brands/b-port/']);
    calls.length = 0;
    // a port-less brand does not match a host with a port: Authentik shows its default brand there
    ak.brands = ak.brands.filter((b) => b.brand_uuid !== 'b-port');
    await post(false);
    expect(patches(/\/core\/brands\//).map((c) => c.path)).toEqual(['/api/v3/core/brands/b-default/']);
  });

  it('preview never carries the password', async () => {
    const r = await as(admin, 'GET');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.json()).toEqual({
      available: true, title: 'Nordlicht TV', logoUrl: LOGO_URL, from: FROM,
      smtp: { available: true, host: 'mail.example.com', port: 587, tls: 'starttls', hasUser: true },
    });
    expect(r.body).not.toContain(PASS);
    expect(r.body).not.toContain(TOKEN);
    expect(calls).toEqual([]); // the preview does not ask Authentik
  });

  it('non-admins get 403', async () => {
    expect((await as(friend, 'GET')).statusCode).toBe(403);
    expect((await as(friend, 'POST', { smtp: false })).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('a body other than { smtp: boolean } is refused', async () => {
    expect((await as(admin, 'POST', { smtp: 'yes' })).statusCode).toBe(400);
    expect((await as(admin, 'POST', { smtp: false, password: 'x' })).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('not configured answers available: false and POST 503 authentik_unavailable', async () => {
    env.ctx.cfg = { ...cfg, ...MAIL, PUBLIC_URL: 'https://friend.example.com', AUTHENTIK_URL: undefined, AUTHENTIK_API_TOKEN: undefined };
    const g = await as(admin, 'GET');
    expect(g.json()).toMatchObject({ available: false, title: 'Nordlicht TV' });
    const r = await post(false);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'authentik_unavailable' });
    expect(calls).toEqual([]);
  });

  it('POST is limited to 6 a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await env.app.inject({ method: 'POST', url: '/api/admin/authentik/branding', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { smtp: false }, remoteAddress: '192.0.2.250' })).statusCode);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes[6]).toBe(429);
  });
});
