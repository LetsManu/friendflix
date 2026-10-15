// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { sha256 } from '../src/crypto.js';
import { createInvite } from '../src/invites.js';
import { flowFailKey } from '../src/routes/authFlow.js';
import { issueSetupCode } from '../src/setup/code.js';
import { isSetupComplete } from '../src/setup/state.js';
import { AK_URL, type AkCall, type FakeAuthentik, fakeAuthentik, type FakeStage, fixture } from './akflow-fake.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Block 23 phase 3, Task 3: the /auth/flow routes (CSRF, single-use steps, rate limits, errors) and the LOGIN_UI switch on /auth/login.

const AK: Partial<Config> = { AUTHENTIK_URL: AK_URL, AUTHENTIK_API_TOKEN: 'api-token-placeholder', OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/' };
const PASSWORD = 'Sup3r-Secret-Passw0rd!';
const RIGHT = 'right-password-placeholder';
const AK_INVITE = 'a0000000-0000-4000-8000-000000000001';

/** identification → password (only RIGHT passes) → end */
const loginStages = (): FakeStage[] => [
  { challenge: fixture('identification'), answer: (b: { uid_field?: string }) => (b.uid_field ? true : fixture('identification')) },
  { challenge: fixture('password'), answer: (b: { password?: string }) => (b.password === RIGHT ? true : fixture('password-invalid')), hops: 2 },
];
/** recovery: identification → e-mail stage (every answer is a resend) */
const recoveryStages = (): FakeStage[] => [
  { challenge: fixture('identification-recovery') },
  { challenge: fixture('email-sent'), answer: () => fixture('email-resent') },
];

const flowsRoute = { 'GET /api/v3/flows/instances/default-recovery-flow/': () => new Response('{"pk":"f1"}', { headers: { 'content-type': 'application/json' } }) };

let ipN = 0;
const freshIp = () => `10.23.${Math.floor(++ipN / 250)}.${ipN % 250}`;

/** one browser: its cookies, its IP, and the flow csrf header taken from its cookie */
function browser(env: TestEnv, extra: Record<string, string> = {}) {
  const cookies: Record<string, string> = { ...extra };
  const ip = freshIp();
  const absorb = (r: { cookies: Array<{ name: string; value: string }> }) => {
    for (const c of r.cookies) {
      if (c.value) cookies[c.name] = c.value;
      else delete cookies[c.name];
    }
  };
  return {
    cookies,
    ip,
    async config() {
      const r = await env.app.inject({ url: '/auth/flow/config', cookies, remoteAddress: ip });
      absorb(r);
      return r;
    },
    async post(path: string, payload: unknown, opts: { csrf?: string | null; headers?: Record<string, string> } = {}) {
      const csrf = opts.csrf === undefined ? cookies.ff_flow_csrf : opts.csrf;
      const r = await env.app.inject({
        method: 'POST', url: `/auth/flow/${path}`, payload: payload as object, cookies, remoteAddress: ip,
        headers: { ...(csrf ? { 'x-ff-flow-csrf': csrf } : {}), ...opts.headers },
      });
      absorb(r);
      return r;
    },
  };
}

const executorPosts = (ak: FakeAuthentik) => ak.calls.filter((c: AkCall) => c.method === 'POST' && c.path.startsWith('/api/v3/flows/executor/'));

describe('/auth/flow', () => {
  let env: TestEnv;
  let ak: FakeAuthentik;
  const logs: string[] = [];
  const useFake = (stages: FakeStage[]) => {
    ak = fakeAuthentik(stages, flowsRoute);
    env.ctx.fetchImpl = ak.fetch;
    return ak;
  };
  beforeAll(async () => {
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: undefined };
    useFake(loginStages());
    for (const k of await env.kv.keys('flowfail:')) await env.kv.del(k); // each test counts its own failures
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(() => env.close());

  async function started(b = browser(env), kind = 'login') {
    await b.config();
    const r = await b.post('start', { kind });
    expect(r.statusCode).toBe(200);
    return { b, step: r.json() as { stage: string; step: string } };
  }

  it('config reports app mode when the API is configured, authentik otherwise', async () => {
    const b = browser(env);
    const r = await b.config();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mode: 'app', recovery: true, enroll: false });
    const c = r.cookies.find((x) => x.name === 'ff_flow_csrf')!;
    expect(c.value.length).toBeGreaterThanOrEqual(32);
    expect([c.httpOnly ?? false, c.sameSite, c.path, c.maxAge]).toEqual([false, 'Strict', '/', 600]);
    // a second call sets a fresh token
    expect((await b.config()).cookies.find((x) => x.name === 'ff_flow_csrf')!.value).not.toBe(c.value);
    // the recovery lookup is cached (one Authentik call for both)
    expect(ak.calls.filter((x) => x.path === '/api/v3/flows/instances/default-recovery-flow/')).toHaveLength(1);

    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' };
    expect((await b.config()).json()).toMatchObject({ mode: 'app', enroll: true });
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_API_TOKEN: undefined };
    expect((await b.config()).json()).toEqual({ mode: 'authentik', recovery: false, enroll: false });
    env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: 'authentik' };
    expect((await b.config()).json()).toEqual({ mode: 'authentik', recovery: false, enroll: false });
  });

  it('config: an unknown recovery slug or an unreachable Authentik → recovery false', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: 'no-such-flow' };
    expect((await browser(env).config()).json()).toEqual({ mode: 'app', recovery: false, enroll: false });
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: 'other-flow' };
    ak.override = () => { throw new TypeError('fetch failed'); };
    expect((await browser(env).config()).json()).toEqual({ mode: 'app', recovery: false, enroll: false });
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: undefined };
  });

  it('start without csrf header → 403', async () => {
    const b = browser(env);
    await b.config();
    expect((await b.post('start', { kind: 'login' }, { csrf: null })).statusCode).toBe(403);
    const wrong = await b.post('start', { kind: 'login' }, { csrf: 'x'.repeat(43) });
    expect([wrong.statusCode, wrong.json()]).toEqual([403, { error: 'csrf' }]);
    // a header without the cookie
    const bare = browser(env);
    expect((await bare.post('start', { kind: 'login' }, { csrf: 'abc' })).statusCode).toBe(403);
    // answer and cancel too
    expect((await b.post('answer', { step: 'x', stage: 'identify', identifier: 'anna' }, { csrf: null })).statusCode).toBe(403);
    expect((await b.post('cancel', {}, { csrf: null })).statusCode).toBe(403);
    expect(ak.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/'))).toHaveLength(0);
  });

  it('start returns identify with a step id and sets ff_flow', async () => {
    const b = browser(env);
    await b.config();
    const r = await b.post('start', { kind: 'login' });
    expect(r.statusCode).toBe(200);
    const step = r.json();
    expect(step).toMatchObject({ stage: 'identify', passwordInline: false, passkey: null });
    expect(step.step).toMatch(/^[A-Za-z0-9_-]{20,24}$/);
    const c = r.cookies.find((x) => x.name === 'ff_flow')!;
    expect([c.httpOnly, c.sameSite, c.path, c.maxAge]).toEqual([true, 'Strict', '/auth/flow', 600]);
    expect(c.value.length).toBeGreaterThanOrEqual(43);
    // no Authentik URL, cookie or token reaches the browser
    expect(r.body).not.toContain('auth.example.com');
    expect(r.body).not.toContain('authentik_session');
    // the jar is stored encrypted under the hash of the flow id
    const blob = await env.kv.get(`akflow:${sha256(c.value)}`);
    expect(blob).toBeTruthy();
    expect(blob).not.toContain('authentik_session');
  });

  it('start: bad bodies → 400; a recovery jar; a second start forgets the first jar', async () => {
    const b = browser(env);
    await b.config();
    for (const body of [{ kind: 'reauth' }, { kind: 'login', extra: 1 }, { kind: 'login', invite: 'x'.repeat(129) }, { kind: 'recovery', invite: 'x'.repeat(30) }]) {
      const r = await b.post('start', body);
      expect([r.statusCode, r.json()], JSON.stringify(body)).toEqual([400, { error: 'bad_request' }]);
    }
    const first = await b.post('start', { kind: 'login' });
    const firstFlow = b.cookies.ff_flow!;
    useFake(recoveryStages());
    const second = await b.post('start', { kind: 'recovery' });
    expect(second.json()).toMatchObject({ stage: 'identify' });
    expect(ak.calls.find((c) => c.path.startsWith('/api/v3/flows/executor/'))!.path).toBe('/api/v3/flows/executor/default-recovery-flow/');
    expect(b.cookies.ff_flow).not.toBe(firstFlow);
    expect(await env.kv.get(`akflow:${sha256(firstFlow)}`)).toBeNull();
    expect(first.statusCode).toBe(200);
  });

  it('start with invites: login keeps a valid invite, enroll needs one with an Authentik invitation', async () => {
    const { cookies } = await env.login();
    const adminId = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    const plain = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    const withAk = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    await env.pool.query('update invites set authentik_invite=$1 where id=$2', [AK_INVITE, withAk.id]);
    expect(cookies.ff_sid).toBeTruthy();
    const b = browser(env);
    await b.config();
    expect((await b.post('start', { kind: 'login', invite: 'n'.repeat(30) })).json()).toEqual({ error: 'invite_invalid' });
    expect((await b.post('start', { kind: 'login', invite: plain.token })).statusCode).toBe(200);
    const enrollNoInvite = await b.post('start', { kind: 'enroll' });
    expect([enrollNoInvite.statusCode, enrollNoInvite.json()]).toEqual([410, { error: 'invite_invalid' }]);
    expect((await b.post('start', { kind: 'enroll', invite: plain.token })).statusCode).toBe(410);
    // no enrolment flow configured
    const nf = await b.post('start', { kind: 'enroll', invite: withAk.token });
    expect([nf.statusCode, nf.json()]).toEqual([409, { error: 'flow_not_configured' }]);
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' };
    useFake([{ challenge: fixture('prompt-enroll') }]);
    const en = await b.post('start', { kind: 'enroll', invite: withAk.token });
    expect(en.json()).toMatchObject({ stage: 'prompt' });
    const call = ak.calls.find((c) => c.path === '/api/v3/flows/executor/default-enrollment-flow/')!;
    expect(call.url.searchParams.get('query')).toBe(`itoken=${AK_INVITE}`);
    // the jar keeps the invite for the end of the flow (P16); the browser never sees the Authentik invitation
    expect(en.body).not.toContain(AK_INVITE);
  });

  it('replaying a step id → 409 step_used and Authentik saw one POST', async () => {
    const { b, step } = await started();
    const body = { step: step.step, stage: 'identify', identifier: 'anna@example.com' };
    const first = await b.post('answer', body);
    expect(first.statusCode).toBe(200);
    const next = first.json();
    expect(next).toMatchObject({ stage: 'password', identity: 'anna@example.com' });
    expect(next.step).not.toBe(step.step);
    const replay = await b.post('answer', body);
    expect([replay.statusCode, replay.json()]).toEqual([409, { error: 'step_used' }]);
    expect(executorPosts(ak)).toHaveLength(1);
  });

  it('a concurrent double submit: one answer reaches Authentik, the other gets 409 step_used', async () => {
    const { b, step } = await started();
    const body = { step: step.step, stage: 'identify', identifier: 'anna@example.com' };
    const rs = await Promise.all([b.post('answer', body), b.post('answer', body)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(executorPosts(ak)).toHaveLength(1);
  });

  it('answer after 601 s → expired, no Authentik call', async () => {
    const { b, step } = await started();
    const before = ak.calls.length;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 601_000);
    const r = await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna@example.com' });
    expect([r.statusCode, r.json()]).toEqual([200, { stage: 'expired' }]);
    expect(ak.calls.length).toBe(before);
    expect(b.cookies.ff_flow).toBeUndefined(); // cleared
    // no cookie at all: expired as well
    const none = browser(env);
    await none.config();
    expect((await none.post('answer', { step: 'x', stage: 'identify', identifier: 'a' })).json()).toEqual({ stage: 'expired' });
  });

  it('answers are checked against the shown step: stage, offered options, shape (400, nothing used up)', async () => {
    const { b, step } = await started();
    const bad = [
      { step: step.step, stage: 'password', password: 'x' }, // not the shown stage
      { step: step.step, stage: 'identify', identifier: 'anna', password: 'x' }, // no inline password offered
      { step: step.step, stage: 'identify', passkey: { id: 'a', rawId: 'a', type: 'public-key', response: { clientDataJSON: 'a' } } }, // no passkey offered
      { step: step.step, stage: 'identify' }, // nothing
      { step: step.step }, // no stage
      { stage: 'identify', identifier: 'anna' }, // no step
    ];
    for (const body of bad) {
      const r = await b.post('answer', body);
      expect([r.statusCode, r.json()], JSON.stringify(body)).toEqual([400, { error: 'bad_request' }]);
    }
    for (const payload of ['"x"', '[1]']) {
      const r = await env.app.inject({ method: 'POST', url: '/auth/flow/answer', payload, headers: { 'content-type': 'application/json', 'x-ff-flow-csrf': b.cookies.ff_flow_csrf! }, cookies: b.cookies, remoteAddress: b.ip });
      expect(r.statusCode).toBe(400);
    }
    const wrongStep = await b.post('answer', { step: 'not-the-step', stage: 'identify', identifier: 'anna' });
    expect([wrongStep.statusCode, wrongStep.json()]).toEqual([409, { error: 'step_used' }]);
    expect(executorPosts(ak)).toHaveLength(0);
    // the step was not used up by the refused answers
    expect((await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna' })).statusCode).toBe(200);
  });

  it('a prompt answer may only carry the shown fields; a password mismatch → 400 {errors}, no Authentik call', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' };
    await env.login();
    const adminId = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    const inv = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    await env.pool.query('update invites set authentik_invite=$1 where id=$2', [AK_INVITE, inv.id]);
    useFake([{ challenge: fixture('prompt-enroll') }]);
    const b = browser(env);
    await b.config();
    const s = (await b.post('start', { kind: 'enroll', invite: inv.token })).json() as { step: string; fields: Array<{ key: string }> };
    const keys = s.fields.map((f) => f.key);
    expect(keys).toContain('password_repeat');
    const extra = await b.post('answer', { step: s.step, stage: 'prompt', is_superuser: 'true' });
    expect(extra.statusCode).toBe(400);
    const mismatch = await b.post('answer', { step: s.step, stage: 'prompt', password: 'a-placeholder', password_repeat: 'b-placeholder' });
    expect([mismatch.statusCode, mismatch.json()]).toEqual([400, { errors: ['password_mismatch'] }]);
    expect(executorPosts(ak)).toHaveLength(0);
  });

  it('ten failed passwords for one identifier → rate_limited without calling Authentik; another identifier still works', async () => {
    const { b, step } = await started();
    let cur = (await b.post('answer', { step: step.step, stage: 'identify', identifier: 'Anna@Example.com' })).json() as { step: string; stage: string };
    expect(cur.stage).toBe('password');
    for (let i = 0; i < 10; i++) {
      const r = await b.post('answer', { step: cur.step, stage: 'password', password: `${PASSWORD}${i}` });
      expect(r.statusCode).toBe(200);
      cur = r.json();
      expect(cur).toMatchObject({ stage: 'password', errors: ['invalid'] });
    }
    expect(await env.kv.get(flowFailKey('anna@example.com'))).toBe('10');
    const posts = executorPosts(ak).length;
    const limited = await b.post('answer', { step: cur.step, stage: 'password', password: RIGHT });
    expect(limited.statusCode).toBe(200);
    const body = limited.json();
    expect(body).toMatchObject({ stage: 'password', errors: ['rate_limited'] });
    expect(body.step).not.toBe(cur.step);
    expect(executorPosts(ak)).toHaveLength(posts);
    // the same account in a new flow, typed differently: refused at identification already
    useFake(loginStages());
    const again = await started();
    const id = await again.b.post('answer', { step: again.step.step, stage: 'identify', identifier: ' ANNA@example.COM' });
    expect(id.json()).toMatchObject({ stage: 'identify', errors: ['rate_limited'] });

    // another identifier is not affected
    useFake(loginStages());
    const other = await started();
    const pw = (await other.b.post('answer', { step: other.step.step, stage: 'identify', identifier: 'bert' })).json() as { step: string };
    const done = await other.b.post('answer', { step: pw.step, stage: 'password', password: RIGHT });
    // Task 3: the end of a flow never issues a session (Task 4's completeFlow does); the Authentik session is ended
    expect([done.statusCode, done.json()]).toEqual([200, { stage: 'unavailable' }]);
    expect(done.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    expect(ak.calls.some((c) => c.path === '/api/v3/flows/executor/default-invalidation-flow/')).toBe(true);
    expect(other.b.cookies.ff_flow).toBeUndefined();
    expect(await env.kv.get(flowFailKey('bert'))).toBeNull();
  });

  it('an email-sent resend does not count as a failure', async () => {
    useFake(recoveryStages());
    const { b, step } = await started(browser(env), 'recovery');
    let cur = (await b.post('answer', { step: step.step, stage: 'identify', identifier: 'carla@example.com' })).json() as { step: string; stage: string };
    expect(cur).toMatchObject({ stage: 'email-sent', to: 'c•••@example.com' });
    for (let i = 0; i < 11; i++) {
      const r = await b.post('answer', { step: cur.step, stage: 'email-sent' });
      cur = r.json();
      expect(cur.stage).toBe('email-sent');
      expect(cur).not.toHaveProperty('errors');
    }
    expect(await env.kv.get(flowFailKey('carla@example.com'))).toBeNull();
  });

  it('select-stage is answered automatically; a wrong TOTP code counts; denied ends the flow', async () => {
    const validate = { component: 'ak-stage-authenticator-validate', device_challenges: [], configuration_stages: [{ pk: 'a1b2c3', meta_model_name: 'authentik_stages_authenticator_totp.authenticatortotpstage' }] };
    useFake([
      { challenge: fixture('identification'), answer: (body: { uid_field?: string }) => (body.uid_field ? true : fixture('identification')) },
      { challenge: validate, answer: (body: { selected_stage?: string }) => (body.selected_stage === 'a1b2c3' ? true : validate) },
      { challenge: fixture('totp-setup'), answer: () => fixture('totp-setup-invalid') },
    ]);
    const { b, step } = await started();
    const totp = await b.post('answer', { step: step.step, stage: 'identify', identifier: 'dora' });
    expect(totp.json()).toMatchObject({ stage: 'totp-setup' });
    expect(executorPosts(ak).map((c) => c.body)).toEqual([{ uid_field: 'dora' }, { selected_stage: 'a1b2c3' }]);
    const wrong = await b.post('answer', { step: totp.json().step, stage: 'totp-setup', code: '000000' });
    expect(wrong.json()).toMatchObject({ stage: 'totp-setup', errors: ['code_invalid'] });
    expect(await env.kv.get(flowFailKey('dora'))).toBe('1');

    useFake([{ challenge: fixture('identification'), answer: () => true }, { challenge: fixture('access-denied') }]);
    const d = await started();
    const denied = await d.b.post('answer', { step: d.step.step, stage: 'identify', identifier: 'emil' });
    expect(denied.json()).toEqual({ stage: 'denied' });
    expect(d.b.cookies.ff_flow).toBeUndefined();
  });

  it('a link interstitial outside resume is never answered: classic consent', async () => {
    useFake([{ challenge: fixture('consent-link') }]);
    const { step } = await started();
    expect(step).toEqual({ stage: 'classic', reason: 'consent' });
    expect(executorPosts(ak)).toHaveLength(0);
  });

  it('Authentik unreachable → stage unavailable', async () => {
    const b = browser(env);
    await b.config();
    ak.override = () => { throw new TypeError('fetch failed'); };
    const r = await b.post('start', { kind: 'login' });
    expect([r.statusCode, r.json()]).toEqual([200, { stage: 'unavailable' }]);
    expect(b.cookies.ff_flow).toBeUndefined();
    // mid-flow: a 5xx page from Authentik
    ak.override = undefined;
    const { b: b2, step } = await started();
    ak.override = (c) => (c.method === 'POST' ? new Response('<html>oops</html>', { status: 500, headers: { 'content-type': 'text/html' } }) : undefined);
    const mid = await b2.post('answer', { step: step.step, stage: 'identify', identifier: 'anna' });
    expect([mid.statusCode, mid.json()]).toEqual([200, { stage: 'unavailable' }]);
  });

  it('a password in the body never appears in captured log lines', async () => {
    const { b, step } = await started();
    const pw = (await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna@example.com' })).json() as { step: string };
    logs.length = 0;
    // the fake throws an error that quotes the request
    ak.override = (c) => { if (c.method === 'POST') throw new Error(`connect failed: ${JSON.stringify(c.body)}`); return undefined; };
    const down = await b.post('answer', { step: pw.step, stage: 'password', password: PASSWORD });
    expect(down.json()).toEqual({ stage: 'unavailable' });
    // an unexpected error inside the handler that quotes the body
    useFake(loginStages());
    const { b: b2, step: s2 } = await started();
    const pw2 = (await b2.post('answer', { step: s2.step, stage: 'identify', identifier: 'anna@example.com' })).json() as { step: string };
    vi.spyOn(env.kv, 'setnx').mockRejectedValueOnce(Object.assign(new Error(`kv failed for ${PASSWORD}`), { code: 'E_TEST' }));
    const boom = await b2.post('answer', { step: pw2.step, stage: 'password', password: PASSWORD });
    expect([boom.statusCode, boom.json()]).toEqual([500, { error: 'internal' }]);
    // a malformed body that contains the password
    await env.app.inject({ method: 'POST', url: '/auth/flow/answer', payload: `{"password":"${PASSWORD}"`, headers: { 'content-type': 'application/json', 'x-ff-flow-csrf': b.cookies.ff_flow_csrf! }, cookies: b.cookies, remoteAddress: b.ip });
    const text = logs.join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('kv failed');
    expect(text).not.toContain('connect failed');
    // what is logged: the route pattern and the code
    const warns = logs.map((l) => JSON.parse(l) as { route?: string; code?: string }).filter((l) => l.route);
    expect(warns).toContainEqual(expect.objectContaining({ route: '/auth/flow/answer', code: 'authentik_unavailable' }));
    expect(warns).toContainEqual(expect.objectContaining({ route: '/auth/flow/answer', code: 'internal' }));
  });

  it('no path trick (percent-encoding, case, double slashes) gets the body into the log', async () => {
    const { b } = await started();
    const variants = ['/auth/flow/answer', '/%61uth/flow/answer', '/auth/%66low/answer', '/auth/flow/%61nswer', '/AUTH/flow/answer', '//auth/flow/answer', '/auth//flow/answer'];
    vi.spyOn(env.kv, 'get').mockImplementation(async (k: string) => { if (k.startsWith('akflow:')) throw new Error(`load failed ${PASSWORD}`); return null; });
    let reached = 0;
    for (const url of variants) {
      logs.length = 0;
      const r = await env.app.inject({ method: 'POST', url, payload: { step: 'st1', stage: 'password', password: PASSWORD }, headers: { 'x-ff-flow-csrf': b.cookies.ff_flow_csrf! }, cookies: b.cookies, remoteAddress: b.ip });
      expect([404, 500], url).toContain(r.statusCode);
      if (r.statusCode === 500) reached++;
      expect(logs.join('\n'), url).not.toContain(PASSWORD);
    }
    expect(reached).toBe(4); // the encoded variants reach the real route
  });

  it('cancel ends the Authentik session, deletes the jar and clears the cookies', async () => {
    const { b, step } = await started();
    await b.post('answer', { step: step.step, stage: 'identify', identifier: 'anna' });
    const flowId = b.cookies.ff_flow!;
    const r = await b.post('cancel', {});
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true }]);
    expect(ak.calls.some((c) => c.path === '/api/v3/flows/executor/default-invalidation-flow/')).toBe(true);
    expect(await env.kv.get(`akflow:${sha256(flowId)}`)).toBeNull();
    expect(b.cookies.ff_flow).toBeUndefined();
    expect(b.cookies.ff_flow_csrf).toBeUndefined();
    // without a jar: still fine
    const n = browser(env);
    await n.config();
    expect((await n.post('cancel', {})).statusCode).toBe(200);
  });

  it('a jar of a signed-in person also needs that session and its x-csrf-token', async () => {
    const { cookies, csrf } = await env.login();
    const sess = JSON.parse((await env.kv.get(`sess:${cookies.ff_sid}`))!) as { userId: string };
    const { b, step } = await started(browser(env, cookies));
    // bind the jar to the session (as Task 10's reauth start will)
    const { loadJar, saveJar } = await import('../src/akflow.js');
    const jar = (await loadJar(env.ctx, b.cookies.ff_flow!))!;
    await saveJar(env.ctx, b.cookies.ff_flow!, { ...jar, userId: sess.userId });
    const body = { step: step.step, stage: 'identify', identifier: 'anna' };
    expect((await b.post('answer', body)).statusCode).toBe(403);
    expect((await b.post('answer', body, { headers: { 'x-csrf-token': 'wrong' } })).statusCode).toBe(403);
    expect((await b.post('cancel', {}, { headers: { 'x-csrf-token': 'wrong' } })).statusCode).toBe(403);
    expect(executorPosts(ak)).toHaveLength(0);
    expect((await b.post('answer', body, { headers: { 'x-csrf-token': csrf } })).statusCode).toBe(200);
  });

  it('LOGIN_UI=authentik: start → 409 classic', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
    const b = browser(env);
    await b.config();
    const r = await b.post('start', { kind: 'login' });
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'classic' }]);
    expect((await b.post('answer', { step: 'x', stage: 'identify', identifier: 'a' })).json()).toEqual({ error: 'classic' });
    expect(ak.calls.filter((c) => c.path.startsWith('/api/v3/flows/executor/'))).toHaveLength(0);
  });

  it('per-IP limit: the 21st start within a minute → 429', async () => {
    const b = browser(env);
    await b.config();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await b.post('start', { kind: 'login' })).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

describe('/auth/login and the LOGIN_UI switch', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  beforeEach(() => { env.ctx.cfg = { ...env.ctx.cfg, ...AK, LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: 'default-enrollment-flow' }; });
  afterAll(() => env.close());
  const loc = async (url: string) => {
    const r = await env.app.inject(url);
    return [r.statusCode, r.headers.location] as const;
  };

  it('/auth/login redirects to /login in app mode, stays on the IdP with classic=1 and with resetPin=1', async () => {
    expect(await loc('/auth/login')).toEqual([302, '/login']);
    expect(await loc('/auth/login?classic=1')).toEqual([302, 'https://idp/authorize']);
    expect(await loc('/auth/login?resetPin=1')).toEqual([302, 'https://idp/authorize']);
    expect(await loc('/auth/login?setup=1')).toEqual([302, 'https://idp/authorize']);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
    expect(await loc('/auth/login')).toEqual([302, 'https://idp/authorize']);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: undefined, AUTHENTIK_API_TOKEN: undefined };
    expect(await loc('/auth/login')).toEqual([302, 'https://idp/authorize']);
  });

  it('invites: checked first (410), then carried to /login; /auth/enroll → /login?invite=…&enroll=1', async () => {
    const r = await env.app.inject('/auth/login?invite=nnnnnnnnnnnnnnnnnnnnnnnnnnn');
    expect([r.statusCode, r.json()]).toEqual([410, { error: 'invite_invalid' }]);
    await env.login();
    const adminId = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    const inv = await createInvite(env.ctx, adminId, { role: 'friend', ttlHours: 1 }, { warn: () => {} });
    await env.pool.query('update invites set authentik_invite=$1 where id=$2', [AK_INVITE, inv.id]);
    expect(await loc(`/auth/login?invite=${inv.token}`)).toEqual([302, `/login?invite=${inv.token}`]);
    expect(await loc(`/auth/enroll?invite=${inv.token}`)).toEqual([302, `/login?invite=${inv.token}&enroll=1`]);
    // the classic enrolment stays reachable
    const classic = await loc(`/auth/enroll?invite=${inv.token}&classic=1`);
    expect(classic[1]).toMatch(/^http:\/\/auth\.example\.com:9000\/if\/flow\/default-enrollment-flow\//);
    env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
    expect((await loc(`/auth/enroll?invite=${inv.token}`))[1]).toMatch(/^http:\/\/auth\.example\.com:9000\/if\/flow\//);
  });
});

describe('the LOGIN_UI switch during setup (preflight D3, D9)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv({}, { setupComplete: false });
    env.ctx.cfg = { ...env.ctx.cfg, ...AK }; // what the automatic Authentik setup saves: loginUi answers app
  });
  afterAll(() => env.close());

  it('/auth/flow/* stays gated (503 setup_required)', async () => {
    for (const [method, url] of [['GET', '/auth/flow/config'], ['POST', '/auth/flow/start'], ['POST', '/auth/flow/answer'], ['POST', '/auth/flow/cancel']] as const) {
      const r = await env.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect([r.statusCode, r.json()], url).toEqual([503, { error: 'setup_required' }]);
    }
  });

  it('/auth/login?setup=1 with a setup session still goes to the IdP, and the callback creates the first admin', async () => {
    const code = await issueSetupCode(env.ctx);
    const u = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: freshIp() });
    const cookies = { ff_setup: u.cookies.find((c) => c.name === 'ff_setup')!.value };
    // also without ?setup=1: no /login redirect while setup is incomplete
    const plain = await env.app.inject({ url: '/auth/login', cookies });
    expect([plain.statusCode, plain.headers.location]).toEqual([302, 'https://idp/authorize']);
    const l = await env.app.inject({ url: '/auth/login?setup=1', cookies });
    expect([l.statusCode, l.headers.location]).toEqual([302, 'https://idp/authorize']);
    const state = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    env.claims.current = { sub: 'sub-first', email: 'first@example.com', name: 'First', groups: [] };
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ...cookies, ff_oidc: state } });
    expect([cb.statusCode, cb.headers.location]).toEqual([302, '/setup/extras']);
    expect((await env.pool.query('select role from users where authentik_sub=$1', ['sub-first'])).rows[0]).toEqual({ role: 'admin' });
    expect(await isSetupComplete(env.ctx)).toBe(true);
    // once complete, the same install signs in through /login
    expect((await env.app.inject('/auth/login')).headers.location).toBe('/login');
  });
});

describe('the session CSRF hook decides by route pattern, never the raw url (carry from Task 1)', () => {
  let env: TestEnv;
  let s: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => {
    env = await makeEnv();
    s = await env.login();
  });
  afterAll(() => env.close());
  const put = (url: string, headers: Record<string, string> = {}) =>
    env.app.inject({ method: 'PUT', url, payload: { onboarded: true }, cookies: s.cookies, headers, remoteAddress: freshIp() });

  it('encoded spellings of a protected route need the token too', async () => {
    for (const url of ['/api/prefs/onboarded', '/%61pi/prefs/onboarded', '/api/%70refs/onboarded', '/api/prefs/%6Fnboarded']) {
      const r = await put(url);
      expect([r.statusCode, r.json()], url).toEqual([403, { error: 'csrf' }]);
      expect((await put(url, { 'x-csrf-token': s.csrf })).statusCode, url).toBe(200);
    }
  });

  it('a request that matches no route gets the strictest branch (403 with a session, no token)', async () => {
    for (const url of ['/API/prefs/onboarded', '//api/prefs/onboarded', '/api//prefs/onboarded', '/api/nope', '/nope', '/api/client-errors-x', '/api/tv/codes', '/api/restore/x', '/api/setup', '/api/invite']) {
      const r = await env.app.inject({ method: 'POST', url, payload: {}, cookies: s.cookies, remoteAddress: freshIp() });
      expect([r.statusCode, r.json()], url).toEqual([403, { error: 'csrf' }]);
    }
    // without a session: the usual 404
    expect((await env.app.inject({ method: 'POST', url: '/api/nope', payload: {} })).statusCode).toBe(404);
  });

  it('the exemptions still work for their real routes (also spelled encoded), and only there', async () => {
    const beacon = (url: string) => env.app.inject({ method: 'POST', url, payload: JSON.stringify({ kind: 'error', message: 'x', path: '/' }), headers: { 'content-type': 'text/plain;charset=UTF-8' }, cookies: s.cookies, remoteAddress: freshIp() });
    for (const url of ['/api/client-errors', '/%61pi/client-errors']) expect((await beacon(url)).statusCode, url).not.toBe(403);
    const tv = await env.app.inject({ method: 'POST', url: '/api/tv/code', cookies: s.cookies, remoteAddress: freshIp() });
    expect(tv.statusCode).not.toBe(403);
    const restore = await env.app.inject({ method: 'POST', url: '/api/restore', payload: {}, cookies: s.cookies, remoteAddress: freshIp() });
    expect([restore.statusCode, restore.json()]).toEqual([401, { error: 'unauthenticated' }]); // no restore cookie, but no csrf 403
    const setup = await env.app.inject({ method: 'PUT', url: '/api/setup/settings', payload: {}, cookies: s.cookies, remoteAddress: freshIp() });
    expect(setup.statusCode).not.toBe(403);
    // GET is never checked
    expect((await env.app.inject({ url: '/%61pi/me', cookies: s.cookies })).statusCode).toBe(200);
  });
});
