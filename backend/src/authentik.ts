// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authentik admin API client for the user detail page: find a portal account's Authentik user, its MFA devices, and send
 * it a password-reset e-mail. Every Authentik call except the invitation ones (invites.ts) goes through this module.
 *
 * Errors are HttpErrors with a code only (`authentik_unavailable`, `authentik_token_rejected`, `authentik_error`, ...):
 * neither the API token nor Authentik's response body ever ends up in a message, so they cannot leak into logs or answers.
 * Lookups answer null when the Authentik API is not configured; actions throw 503 `authentik_unavailable`.
 */
import type { Ctx } from './ctx.js';
import { akBase } from './invites.js';
import { HttpError } from './users.js';

type AkCtx = Pick<Ctx, 'cfg' | 'kv' | 'db' | 'fetchImpl'>;
export interface AkUser { pk: number; username: string; email: string }
export interface MfaState { totp: boolean; webauthn: boolean; static: boolean }

const TIMEOUT_MS = 5_000;
const MFA_TTL = 600;
const USER_TTL = 3600;
/** user list pages scanned for a hashed sub before giving up (100 users per page) */
const MAX_PAGES = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const configured = (ctx: AkCtx) => Boolean(ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_API_TOKEN);

/** One API call. Network failure / timeout -> 503; 401/403 -> 502 `authentik_token_rejected`; other non-2xx -> 502 (or `expect` maps it). */
async function call(ctx: AkCtx, path: string, init: RequestInit = {}, expect: Partial<Record<number, HttpError>> = {}): Promise<Response> {
  const { AUTHENTIK_URL: url, AUTHENTIK_API_TOKEN: tok } = ctx.cfg;
  if (!url || !tok) throw new HttpError(503, 'authentik_unavailable');
  let r: Response;
  try {
    r = await ctx.fetchImpl(new URL(path, akBase(url) + '/'), {
      ...init,
      headers: { authorization: `Bearer ${tok}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, 'authentik_unavailable'); // the cause may quote the request (headers): never attached
  }
  if (r.ok) return r;
  await r.body?.cancel().catch(() => undefined);
  const mapped = expect[r.status];
  if (mapped) throw mapped;
  throw new HttpError(502, r.status === 401 || r.status === 403 ? 'authentik_token_rejected' : 'authentik_error');
}

async function json<T>(ctx: AkCtx, path: string, init?: RequestInit, expect?: Partial<Record<number, HttpError>>): Promise<T> {
  const r = await call(ctx, path, init, expect);
  try {
    return (await r.json()) as T;
  } catch {
    throw new HttpError(502, 'authentik_error');
  }
}

interface Page<T> { pagination?: { next?: number }; results: T[] }
interface RawUser { pk: number; username: string; email?: string; uid?: string; uuid?: string }
const toUser = (u: RawUser): AkUser => ({ pk: u.pk, username: u.username, email: u.email ?? '' });

/**
 * The Authentik user behind an OIDC `sub`. Authentik's default subject mode is the hashed user id, which the API shows as
 * `uid` (it is not a filter): a uuid sub (mode "user UUID") is looked up with `?uuid=`, otherwise the account's e-mail
 * narrows the search (`?search=`) and, failing that, the user list is paged. Matches only on `uid` / `uuid`. Cached 1 h.
 */
export async function akUserBySub(ctx: AkCtx, sub: string): Promise<AkUser | null> {
  if (!configured(ctx)) return null;
  const key = `akuser:${sub}`;
  const hit = await ctx.kv.get(key);
  if (hit) return JSON.parse(hit) as AkUser;
  const match = (rows: RawUser[]) => rows.find((u) => u.uid === sub || u.uuid === sub);
  const list = (q: Record<string, string>) => json<Page<RawUser>>(ctx, `api/v3/core/users/?${new URLSearchParams({ include_groups: 'false', ...q })}`);

  let found: RawUser | undefined;
  if (UUID_RE.test(sub)) found = match((await list({ uuid: sub })).results);
  if (!found) {
    const email = (await ctx.db.query<{ email: string | null }>('select email from users where authentik_sub=$1', [sub])).rows[0]?.email;
    if (email) found = match((await list({ search: email })).results);
  }
  for (let page = 1; !found && page <= MAX_PAGES; page++) {
    const r = await list({ page: String(page), page_size: '100' });
    found = match(r.results);
    if (!r.pagination?.next) break;
  }
  if (!found) return null;
  const user = toUser(found);
  await ctx.kv.set(key, JSON.stringify(user), USER_TTL);
  return user;
}

/**
 * Which kinds of MFA devices the user has (`GET /authenticators/admin/all/?user=<pk>`, cached 10 min).
 * The device `type` is "<app>.<model>", e.g. authentik_stages_authenticator_totp.totpdevice; unconfirmed devices do not count.
 */
export async function akMfaState(ctx: AkCtx, sub: string): Promise<MfaState | null> {
  if (!configured(ctx)) return null;
  const key = `akmfa:${sub}`;
  const hit = await ctx.kv.get(key);
  if (hit) return JSON.parse(hit) as MfaState;
  const user = await akUserBySub(ctx, sub);
  if (!user) return null;
  const r = await json<Array<{ type?: string; confirmed?: boolean }> | Page<{ type?: string; confirmed?: boolean }>>(ctx, `api/v3/authenticators/admin/all/?user=${user.pk}`);
  const types = (Array.isArray(r) ? r : r.results).filter((d) => d.confirmed !== false).map((d) => (d.type ?? '').toLowerCase());
  const has = (kind: string) => types.some((t) => t.includes(`authenticator_${kind}.`));
  const state: MfaState = { totp: has('totp'), webauthn: has('webauthn'), static: has('static') };
  await ctx.kv.set(key, JSON.stringify(state), MFA_TTL);
  return state;
}

const notConfigured = () => new HttpError(409, 'recovery_not_configured');

/** The first `ak-stage-email` stage bound to the flow (by binding order). 409 `recovery_not_configured` without flow or stage. */
async function emailStageOf(ctx: AkCtx, slug: string): Promise<string> {
  const flow = await json<{ pk: string }>(ctx, `api/v3/flows/instances/${encodeURIComponent(slug)}/`, undefined, { 404: notConfigured() });
  const r = await json<Page<{ order: number; stage: string; stage_obj?: { component?: string } }>>(
    ctx, `api/v3/flows/bindings/?${new URLSearchParams({ target: flow.pk, ordering: 'order', page_size: '100' })}`);
  const stage = [...r.results].sort((a, b) => a.order - b.order).find((b) => b.stage_obj?.component === 'ak-stage-email')?.stage;
  if (!stage) throw notConfigured();
  return stage;
}

/**
 * Sends the user Authentik's password-reset e-mail: `POST /core/users/<pk>/recovery_email/?email_stage=<uuid>` with the
 * first e-mail stage of AUTHENTIK_RECOVERY_FLOW. Authentik builds the link from the brand's recovery flow (404 without one
 * -> 409 `recovery_not_configured`) and sends it through that stage's SMTP settings.
 */
export async function akSendRecovery(ctx: AkCtx, sub: string): Promise<void> {
  if (!configured(ctx)) throw new HttpError(503, 'authentik_unavailable');
  const user = await akUserBySub(ctx, sub);
  if (!user) throw new HttpError(404, 'authentik_user_not_found');
  const stage = await emailStageOf(ctx, ctx.cfg.AUTHENTIK_RECOVERY_FLOW || 'default-recovery-flow');
  // the stage goes as query parameter (older releases) and as body (newer ones take a serializer); each ignores the other
  await call(ctx, `api/v3/core/users/${user.pk}/recovery_email/?${new URLSearchParams({ email_stage: stage })}`,
    { method: 'POST', body: JSON.stringify({ email_stage: stage }) }, { 404: notConfigured() });
}

/**
 * "Send a 2FA setup link" is not possible through the Authentik API: `GET /flows/instances/<slug>/execute/` returns a link
 * for the token's own user (the service account), not for another user, and there is no "send setup e-mail" endpoint.
 * So this answers 501 `not_supported` (503 without the API) and the UI hides the action. AUTHENTIK_TOTP_SETUP_FLOW
 * (default default-authenticator-totp-setup) is kept for the in-app setup flow of a later phase.
 */
export async function akSendMfaSetup(ctx: AkCtx, _sub: string): Promise<void> {
  if (!configured(ctx)) throw new HttpError(503, 'authentik_unavailable');
  throw new HttpError(501, 'not_supported');
}

/** Whether the Authentik actions can be offered at all (the UI hides them otherwise). */
export const akActions = (ctx: AkCtx) => ({ recovery: configured(ctx), mfaSetup: false });
