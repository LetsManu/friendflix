import pg from 'pg';
import { buildApp, type Extra } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Ctx } from '../src/ctx.js';
import { keyFromBase64 } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { JellyfinService } from '../src/jellyfin/service.js';
import { MemoryKV } from '../src/kv.js';
import { SeerrClient } from '../src/seerr/client.js';
import type { OidcClaims } from '../src/oidc.js';
import { DEFAULT_ROLES } from '../src/roles.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/ff_test';
export const ENC_KEY = Buffer.alloc(32, 7).toString('base64');

export const cfg: Config = {
  PORT: 3000, PUBLIC_URL: 'https://portal.example.com', DATABASE_URL: TEST_DB, REDIS_URL: 'redis://x', SESSION_TTL_SECONDS: 600,
  APP_ENC_KEY: ENC_KEY, INTERNAL_SECRET: 'internal-secret-123456', WEBHOOK_SECRET: 'webhook-secret-123456', ADMIN_GROUP: 'friendflix-admins',
  OIDC_ISSUER: 'https://auth.example.com/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
  JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'adminkey', SEERR_URL: 'http://seerr:5055', SEERR_API_KEY: 'seerrkey',
  NTFY_URL: undefined, DISCORD_WEBHOOK_URL: undefined, METRICS_TOKEN: undefined, AUTHENTIK_URL: undefined, AUTHENTIK_API_TOKEN: undefined,
  AUTHENTIK_ENROLL_FLOW: undefined, ROLE_TEMPLATES: undefined, OIDC_ALLOW_INSECURE: 'false', BACKGROUND_JOBS: 'false',
};

export type Handler = (url: URL, init: RequestInit, body: any) => { status?: number; json?: unknown } | undefined;
export interface Call { method: string; path: string; search: string; body: any; auth?: string }

/** In-memory fake of the Jellyfin/Seerr HTTP APIs: routes are matched by "METHOD /path". */
export function fakeHttp(routes: Record<string, Handler>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body, auth: (init.headers as Record<string, string> | undefined)?.Authorization });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && new RegExp(`^${p}$`).test(url.pathname);
    });
    const r = key ? routes[key]!(url, init, body) : undefined;
    const status = r?.status ?? (key ? 200 : 404);
    return new Response(status === 204 || r?.json === undefined ? null : JSON.stringify(r.json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

export async function resetDb(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: TEST_DB, max: 5 });
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(pool);
  return pool;
}

export interface TestEnv {
  ctx: Ctx;
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: pg.Pool;
  jfCalls: Call[];
  seerrCalls: Call[];
  claims: { current: OidcClaims };
  kv: MemoryKV;
  login: (claims?: OidcClaims) => Promise<{ cookies: Record<string, string>; csrf: string }>;
  close: () => Promise<void>;
}

export const ADMIN: OidcClaims = { sub: 'sub-admin', email: 'admin@example.com', name: 'Admin', groups: ['friendflix-admins'] };

export function defaultJellyfin(): Record<string, Handler> {
  let n = 0;
  return {
    'POST /Users/New': (_u, _i, b) => ({ json: { Id: `jf${String(++n).padStart(30, '0')}ab`, Name: b.Name } }),
    'GET /Users/[^/]+': () => ({ json: { Policy: { IsAdministrator: false, Keep: 'me' } } }),
    'POST /Users/[^/]+/Policy': () => ({ status: 204 }),
    'POST /Users/AuthenticateByName': (_u, _i, b) => ({ json: { AccessToken: `tok-${b.Username}`, User: { Id: 'x', Name: b.Username } } }),
    'GET /Library/MediaFolders': () => ({ json: { Items: [{ Id: 'f1', Name: 'Filme' }, { Id: 'f2', Name: 'Serien' }] } }),
    'GET /System/Ping': () => ({ json: 'Jellyfin Server' }),
  };
}

export async function makeEnv(extraJf: Record<string, Handler> = {}, extra: Extra & { ctxPatch?: (c: Ctx) => void; seerr?: Record<string, Handler> } = {}): Promise<TestEnv> {
  const pool = await resetDb();
  const kv = new MemoryKV();
  const jfCalls: Call[] = [];
  const seerrCalls: Call[] = [];
  const claims = { current: ADMIN };
  const client = new JellyfinClient(cfg.JELLYFIN_URL, cfg.JELLYFIN_ADMIN_API_KEY, fakeHttp({ ...defaultJellyfin(), ...extraJf }, jfCalls));
  const encKey = keyFromBase64(ENC_KEY);
  const ctx: Ctx = {
    cfg, kv, db: pool, encKey, fetchImpl: fetch,
    roles: DEFAULT_ROLES,
    jf: new JellyfinService(client, kv, encKey),
    seerr: new SeerrClient(cfg.SEERR_URL, cfg.SEERR_API_KEY, fakeHttp(extra.seerr ?? {}, seerrCalls)),
    oidc: {
      start: async () => ({ url: 'https://idp/authorize', state: 's' + Math.random().toString(36).slice(2), nonce: 'n', codeVerifier: 'v' }),
      finish: async () => claims.current,
    },
  };
  extra.ctxPatch?.(ctx);
  const app = await buildApp(ctx, extra);
  const login = async (c: OidcClaims = claims.current) => {
    claims.current = c;
    const l = await app.inject('/auth/login');
    const state = new URL(String(l.headers.location)).searchParams.get('state') ?? '';
    // state is embedded in the fake url? it is not: read it back from kv
    const key = (await kv.keys('oidc:'))[0]!;
    const cb = await app.inject(`/auth/callback?state=${key.slice(5)}&code=c`);
    void state;
    if (cb.statusCode !== 302) throw new Error(`login failed ${cb.statusCode} ${cb.body}`);
    const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
    const me = await app.inject({ url: '/api/me', cookies: { ff_sid: sid } });
    return { cookies: { ff_sid: sid }, csrf: me.json().csrfToken as string };
  };
  return { ctx, app, pool, jfCalls, seerrCalls, claims, kv, login, close: async () => { await app.close(); await pool.end(); } };
}

