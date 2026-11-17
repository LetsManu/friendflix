// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Setup wizard fixtures (shapes follow backend/src/routes/setup.ts). Stateful: unlocking opens the setup session (cookies
 * ff_setup + ff_setup_csrf), saves mark the steps done. Every write must carry x-ff-setup-csrf equal to the cookie, like the backend.
 * While `complete` is false, /api/me answers 503 setup_required (mocks/api.ts).
 */
import { mediaManaged, mediaStatus } from './admin.js';
import { plexUrlErrors } from './settings.js';

type Step = 'todo' | 'done' | 'env';
export interface ProbeMock { ok: boolean; code: string; detail?: string }
export interface AkStepMock { id: string; state: string; detail?: string }
export interface SetupMock {
  /** 'jellyfin' | 'plex' (GET /api/setup/state mediaKind) */
  mediaKind: 'jellyfin' | 'plex';
  complete: boolean;
  unlocked: boolean;
  /** the code from the log (any case, dashes optional) */
  code: string;
  /** the next unlock answers this error (status, body) instead of checking the code */
  unlockError: { status: number; error: string } | null;
  media: { keys: string[]; auto: string[] | null };
  steps: { publicUrl: Step; media: Step; signin: Step; admin: Step };
  /** the backend's prefill: the saved PUBLIC_URL, else the browser's origin */
  prefill: { publicUrl: string | null };
  /** 'authentik' after a successful apply; a PUT of a sign-in key clears it */
  signinVia: 'authentik' | null;
  /** POST /api/setup/test answers per group */
  testResults: Record<string, ProbeMock>;
  /** the next PUT /api/setup/settings without force answers 400 probe_failed with this probe (then it is cleared) */
  saveProbeFail: ProbeMock | null;
  /** the next PUT answers this error (then it is cleared) */
  saveError: { status: number; body: object } | null;
  /** answer of POST /api/setup/media/auto (200) */
  autoResult: { ok: true } | ProbeMock;
  planSteps: AkStepMock[];
  /** answer of POST /api/setup/authentik/apply: status + body */
  apply: { status: number; body: object };
  /** apply waits this long (the real one takes ~30 s) */
  applyDelayMs: number;
  puts: Array<{ values: Record<string, unknown>; force?: boolean }>;
  tests: Array<{ group: string; values?: Record<string, unknown> }>;
  autos: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  applies: Array<Record<string, unknown>>;
  unlocks: string[];
  /** writes whose x-ff-setup-csrf did not match the cookie */
  badCsrf: number;
  /** step 3's managed media server (GET/POST /api/setup/mediaserver…); null: a backend without these routes (404) */
  mediaserver: SetupMediaMock | null;
}

/**
 * The wizard's media server routes (backend routes/adminMediaserver.ts setupMediaserverRoutes): the view, the base code, the browser,
 * the GPU, apply and the actions retry / hdr-test. Stateful like the Admin card's mock (mocks/admin.ts): an apply starts the first run,
 * which walks `setupSeq` one step per GET of the view; `done` also marks the wizard's media step done (the first run saved the address).
 */
export interface SetupMediaMock {
  mode: 'managed' | 'external';
  offer: { managed: boolean; reason: string | null };
  kinds: { ferrofin: boolean; jellyfin: boolean };
  status: any;
  managed: any;
  /** the code the updater printed (case and dashes do not matter) */
  code: string;
  /** directories per rel ('' = the base) */
  tree: Record<string, Array<{ name: string; symlink?: boolean; unreadable?: boolean }>>;
  gpu: { dri: Array<{ node: string; gid: number; vendor: string }>; nvidia: boolean };
  /** the first run's steps after an apply, one per GET of the view */
  setupSeq: string[];
  /** the next write answers this refusal once */
  refuse: { status: number; error: string } | null;
  calls: Array<{ p: string; body: any }>;
}
/** offered: an updater that reaches its engine (both images pinned); else the default of an install without one (no_updater) */
export function setupMedia(offered: boolean): SetupMediaMock {
  return {
    mode: 'external',
    offer: offered ? { managed: true, reason: null } : { managed: false, reason: 'no_updater' },
    kinds: { ferrofin: offered, jellyfin: offered },
    status: offered ? mediaStatus() : null,
    managed: mediaManaged(),
    code: 'ABCD-EFGH-JKMN',
    tree: { '': [{ name: 'Filme' }, { name: 'Serien' }, { name: 'Musik' }], Filme: [{ name: 'Klassiker' }, { name: 'Neu' }], Serien: [], Musik: [] },
    gpu: { dri: [{ node: 'renderD128', gid: 109, vendor: 'intel' }], nvidia: false },
    setupSeq: ['first_run', 'api_key', 'libraries', 'hwaccel', 'finishing', 'done'],
    refuse: null, calls: [],
  };
}

export const SETUP_CODE = 'K7QM-3XA9-PT2D';
const CSRF = 'mock-setup-csrf-token';
const AK_PLAN: AkStepMock[] = [
  { id: 'check', state: 'ok' }, { id: 'groups', state: 'create' }, { id: 'provider', state: 'update' }, { id: 'serviceAccount', state: 'create' },
  { id: 'enrollment', state: 'create' }, { id: 'recovery', state: 'exists' }, { id: 'brand', state: 'create' }, { id: 'extraFlows', state: 'skip' },
];
export const AK_APPLIED: AkStepMock[] = [
  { id: 'check', state: 'ok' }, { id: 'groups', state: 'ok' }, { id: 'provider', state: 'ok' }, { id: 'serviceAccount', state: 'ok' },
  { id: 'enrollment', state: 'ok' }, { id: 'recovery', state: 'exists' }, { id: 'brand', state: 'ok' }, { id: 'readback', state: 'ok' },
  { id: 'adminMember', state: 'ok' }, { id: 'extraFlows', state: 'skip' },
];

export function setupState(kind: 'jellyfin' | 'plex' = 'jellyfin'): SetupMock {
  return {
    mediaKind: kind,
    complete: false, unlocked: false, code: SETUP_CODE, unlockError: null,
    // Plex is manual only (no automatic key): the keys are the address and the token
    media: kind === 'plex' ? { keys: ['PLEX_URL', 'PLEX_TOKEN'], auto: null } : { keys: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'], auto: ['url', 'username', 'password'] },
    steps: { publicUrl: 'todo', media: 'todo', signin: 'todo', admin: 'todo' },
    prefill: { publicUrl: 'https://tv.example.com' }, signinVia: null,
    testResults: {}, saveProbeFail: null, saveError: null, autoResult: { ok: true },
    planSteps: AK_PLAN, apply: { status: 200, body: { ok: true, steps: AK_APPLIED } }, applyDelayMs: 0,
    puts: [], tests: [], autos: [], plans: [], applies: [], unlocks: [], badCsrf: 0,
    mediaserver: setupMedia(false),
  };
}

const norm = (s: string) => s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const SIGNIN = /^(OIDC_|AUTHENTIK_|ADMIN_GROUP$)/;

type Reply = (b: unknown, status?: number, headers?: Record<string, string>) => Promise<void>;

/** null when the path is not a setup endpoint */
export function setupRoute(st: SetupMock, m: string, p: string, body: any, headers: Record<string, string>, J: Reply): Promise<void> | null {
  if (p === '/api/setup/state' && m === 'GET') {
    if (st.complete) return J({ complete: true }); // nothing else once complete (backend: routes/setup.ts)
    return J({ complete: false, unlocked: st.unlocked, mediaKind: st.mediaKind, media: st.media, steps: st.steps, prefill: st.prefill, signinVia: st.signinVia });
  }
  if (p === '/api/setup/unlock' && m === 'POST') {
    st.unlocks.push(String(body.code ?? ''));
    if (st.complete) return J({ error: 'setup_complete' }, 409);
    if (st.unlockError) return J({ error: st.unlockError.error }, st.unlockError.status);
    if (norm(String(body.code ?? '')) !== norm(st.code)) return J({ error: 'wrong_code' }, 401);
    st.unlocked = true;
    return J({ ok: true }, 200, { 'set-cookie': `ff_setup_csrf=${CSRF}; Path=/; SameSite=Strict` });
  }
  if (!p.startsWith('/api/setup/')) return null;
  // the session endpoints (requireSetupSession)
  if (st.complete) return J({ error: 'setup_complete' }, 409);
  if (!st.unlocked) return J({ error: 'setup_session_required' }, 401);
  // reads need the session only (requireSetupSession)
  if (m !== 'GET' && (headers['x-ff-setup-csrf'] !== CSRF || !(headers.cookie ?? '').includes(`ff_setup_csrf=${CSRF}`))) { st.badCsrf++; return J({ error: 'csrf' }, 403); }
  if (p.startsWith('/api/setup/mediaserver')) return st.mediaserver ? setupMediaRoute(st, st.mediaserver, m, p, body, J) : J({ error: 'not_found' }, 404);
  if (p === '/api/setup/settings' && m === 'PUT') {
    const values: Record<string, unknown> = body.values ?? {};
    st.puts.push(body.force === undefined ? { values } : { values, force: body.force });
    if (st.saveError) { const e = st.saveError; st.saveError = null; return J(e.body, e.status); }
    const badUrl = plexUrlErrors(values);
    if (Object.keys(badUrl).length) return J({ error: 'invalid_settings', errors: badUrl }, 400);
    if (st.saveProbeFail && !body.force) { const probe = st.saveProbeFail; st.saveProbeFail = null; return J({ error: 'probe_failed', group: 'media', probe }, 400); }
    const keys = Object.keys(values);
    if (keys.includes('PUBLIC_URL')) st.steps.publicUrl = 'done';
    if (keys.some((k) => st.media.keys.includes(k))) st.steps.media = 'done';
    if (keys.some((k) => SIGNIN.test(k))) { st.steps.signin = 'done'; st.signinVia = null; }
    return J({ rev: 3 });
  }
  if (p === '/api/setup/test' && m === 'POST') {
    st.tests.push(body);
    const badUrl = plexUrlErrors(body.values ?? {});
    if (Object.keys(badUrl).length) return J({ error: 'invalid_settings', errors: badUrl }, 400);
    return J(st.testResults[body.group] ?? { ok: true, code: 'ok' });
  }
  if (p === '/api/setup/media/auto' && m === 'POST') {
    st.autos.push(body);
    if (st.autoResult.ok) st.steps.media = 'done';
    return J(st.autoResult);
  }
  if (p === '/api/setup/authentik/plan' && m === 'POST') {
    st.plans.push(body);
    return J({ steps: st.planSteps });
  }
  if (p === '/api/setup/authentik/apply' && m === 'POST') {
    st.applies.push(body);
    const done = () => {
      if (st.apply.status === 200 && (st.apply.body as { ok?: boolean }).ok) { st.steps.signin = 'done'; st.signinVia = 'authentik'; }
      return J(st.apply.body, st.apply.status);
    };
    return st.applyDelayMs ? new Promise((r) => setTimeout(r, st.applyDelayMs)).then(done) : done();
  }
  return null;
}

function setupMediaRoute(st: SetupMock, ms: SetupMediaMock, m: string, p: string, body: any, J: Reply): Promise<void> | null {
  const P = '/api/setup/mediaserver';
  if (m !== 'GET') ms.calls.push({ p, body });
  if (m !== 'GET' && ms.refuse) { const r = ms.refuse; ms.refuse = null; return J({ error: r.error }, r.status); }
  if (p === P && m === 'GET') {
    if (ms.mode === 'managed' && !['done', 'none', 'failed'].includes(ms.managed.setup) && !ms.managed.setupError && ms.setupSeq.length) {
      ms.managed.setup = ms.setupSeq.shift();
      if (ms.managed.setup === 'done') {
        ms.managed.libraries = ms.managed.libraries.map((l: any) => ({ ...l, created: true }));
        st.steps.media = 'done';
      }
    }
    return J({ mode: ms.mode, offer: ms.offer, kinds: ms.kinds, status: ms.status, managed: ms.managed, external: { url: null, hasKey: false }, livetvLibraryPath: null });
  }
  if (p === `${P}/base` && m === 'POST') {
    ms.status.base = { ...ms.status.base, pending: true, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), requested: body.path };
    return J({ pending: true, expiresAt: ms.status.base.expiresAt, warning: null });
  }
  if (p === `${P}/base/confirm` && m === 'POST') {
    const norm = (c: string) => String(c).toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (!ms.status.base.pending) return J({ error: 'no_pending' }, 409);
    if (norm(body.code) !== norm(ms.code)) return J({ error: 'wrong' }, 409);
    const path = ms.status.base.requested;
    ms.status.base = { set: true, path, pending: false, expiresAt: null };
    return J({ result: 'ok', path, kept: [], dropped: [], job: null });
  }
  if (p === `${P}/browse` && m === 'POST') return J({ entries: (ms.tree[body.rel] ?? []).map((e) => ({ symlink: false, unreadable: false, ...e })), truncated: false });
  if (p === `${P}/gpu` && m === 'POST') return J(ms.gpu);
  if (p === `${P}/apply` && m === 'POST') {
    const libs = body.folders.map((f: any) => ({ slug: f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: f.name, type: f.type, rel: f.rel, created: false }));
    ms.mode = 'managed';
    ms.managed = { ...ms.managed, kind: body.kind, libraries: libs, setup: 'applying', setupError: null, adminUser: 'friendflix-admin', hasPassword: true };
    ms.status.desired = { kind: body.kind, folders: libs.map((l: any) => ({ rel: l.rel, target: `/media/${l.slug}` })), uid: body.uid, gid: body.gid, gpu: body.gpu, mediaGid: body.mediaGid, egress: body.egress, run: true };
    ms.status.container = { state: 'running', health: 'starting', kind: body.kind, image: { digest: `sha256:${'a'.repeat(64)}`, upstream: '10.11.0' }, template: 'current', tampered: false, createdAt: new Date().toISOString() };
    return J({ job: { id: '0123456789abcd05', action: 'mediaserver-apply', state: 'running' } }, 202);
  }
  if (p === `${P}/action` && m === 'POST') {
    if (body.op === 'retry') { ms.managed.setupError = null; return J({ ok: true }); }
    if (body.op === 'hdr-test') return J({ job: { id: '0123456789abcd08', action: 'mediaserver-hdr-test', state: 'running' } }, 202);
    return J({ error: 'invalid_body' }, 400);
  }
  return J({ error: 'not_found' }, 404);
}
