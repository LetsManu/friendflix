// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '../../config.js';
import type { LoginCheck } from '../../flowCheck.js';
import type { HealthSnapshot } from '../../health.js';
import type { GroupCheck } from '../engine.js';
import { bad, line } from '../line.js';
import { SIGNIN_TIMEOUT_MS, type CheckLine, type CheckStatus } from '../types.js';
import { levelToStatus, msOf, service } from './util.js';

/**
 * Anmeldung: OIDC discovery from the health snapshot, everything else from the sign-in status check (flowCheck.ts, the LoginCard's
 * source), so the card and the Systemcheck say the same. Its Authentik reads run one after another: this group has the longer limit, and
 * when it misses it the check keeps running and fills its own cache for the next load.
 */
const LOGIN_CARD = '/admin/status#login';
const EMAIL_STAGE = 'authentik_stages_email.emailstage';
/** the warnings of checkLoginFlows that mean a flow or the provider is not as the in-app sign-in needs it */
const FLOW_WARNING = /^(flow_missing|flow_unsupported):|^(consent|auth_code_grant)$/;

/** no Authentik API: the setting that is missing (the address, else the token) */
const apiKey = (cfg: Config) => (cfg.AUTHENTIK_URL ? 'AUTHENTIK_API_TOKEN' : 'AUTHENTIK_URL');
const noApi = (lc: LoginCheck) => lc.serviceToken === null;
const tokenBad = (lc: LoginCheck) => lc.serviceToken?.token === 'invalid';
const unreachable = (lc: LoginCheck) => lc.serviceToken?.token === 'unreachable' || lc.unreachable;
/** the flows could not be read: never report them as missing or fine */
const flowsUnread = (lc: LoginCheck) => tokenBad(lc) || unreachable(lc) || Boolean(lc.serviceToken?.missing.includes('view_flow'));

function oidcLine(s: HealthSnapshot | null): CheckLine {
  const id = 'signin.oidc';
  const h = service(s, 'oidc');
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const status = levelToStatus(h.level, h.reason);
  const ms = msOf(h);
  if (status === 'ok') return line(id, 'ok', ms);
  if (status === 'problem') return bad(id, status, h.reason === 'issuer_mismatch' ? 'oidc_issuer_mismatch' : 'oidc_down', { ...ms, settingKey: 'OIDC_ISSUER' });
  if (status === 'warning') return bad(id, status, 'oidc_slow', ms);
  return bad(id, 'unknown', 'check_unavailable');
}

function authentikLine(cfg: Config, lc: LoginCheck): CheckLine {
  const id = 'signin.authentik';
  if (noApi(lc)) return bad(id, 'not_set_up', 'authentik_not_set', { settingKey: apiKey(cfg) });
  // the in-app sign-in needs the API on every sign-in; the classic sign-in page only for invitations and the account page
  const severity: CheckStatus = lc.mode === 'app' ? 'problem' : 'warning';
  if (tokenBad(lc)) return bad(id, severity, 'ak_token_invalid', { settingKey: 'AUTHENTIK_API_TOKEN' });
  if (unreachable(lc)) return bad(id, severity, 'ak_unreachable', { settingKey: 'AUTHENTIK_URL' });
  if (lc.executor && !lc.executor.ok) return bad(id, severity, 'ak_executor', { params: { cls: lc.executor.cls }, href: LOGIN_CARD });
  const perms = lc.warnings.filter((w) => w.startsWith('permission:')).map((w) => w.slice('permission:'.length));
  if (perms.length) return bad(id, 'warning', 'ak_permission', { params: { perms: perms.join(',') }, href: LOGIN_CARD });
  return line(id, 'ok');
}

function flowsLine(cfg: Config, lc: LoginCheck): CheckLine {
  const id = 'signin.flows';
  if (noApi(lc)) return bad(id, 'not_set_up', 'authentik_not_set', { settingKey: apiKey(cfg) });
  if (flowsUnread(lc)) return bad(id, 'unknown', 'flows_unchecked', { href: LOGIN_CARD });
  const found = lc.warnings.filter((w) => FLOW_WARNING.test(w));
  if (!found.length) return line(id, 'ok');
  // the first as the cause, the count for "and n more"; the card (with the repair) has the full table
  const [code, kind] = found[0]!.split(':');
  return bad(id, 'warning', code!, { params: { n: found.length, flow: kind?.replace(/-/g, '_') }, href: LOGIN_CARD });
}

function issuerLine(cfg: Config, lc: LoginCheck): CheckLine {
  const id = 'signin.issuerHost';
  if (!cfg.AUTHENTIK_URL) return bad(id, 'not_set_up', 'authentik_not_set', { settingKey: 'AUTHENTIK_URL' });
  return lc.issuerMatches ? line(id, 'ok') : bad(id, 'warning', 'issuer_not_on_authentik', { settingKey: 'OIDC_ISSUER' });
}

/** precedence: why passkeys are not in the app at all, then the passkey sign-in on the login flow, then its user verification */
function passkeysLine(lc: LoginCheck): CheckLine {
  const id = 'signin.passkeys';
  switch (lc.passkeysReason) {
    case 'disabled': return bad(id, 'not_set_up', 'passkeys_off', { settingKey: 'PASSKEYS_IN_APP' });
    case 'not_configured': return bad(id, 'not_set_up', 'authentik_not_set', { settingKey: 'AUTHENTIK_URL' });
    case 'not_https': return bad(id, 'warning', 'passkeys_not_https', { settingKey: 'PUBLIC_URL' });
    // the proxy in front of Authentik drops the forwarded host: fixed in the proxy, not in a setting
    case 'forwarded_host_ignored': return bad(id, 'warning', 'forwarded_host_ignored', { fix: 'proxy_forward_host', docs: 'authentik.md#23-reverse-proxy-nginx-proxy-manager' });
    case 'probe_not_found': return bad(id, 'warning', 'passkeys_probe_not_found', { settingKey: 'OIDC_ISSUER' });
    case 'unreachable': return bad(id, 'warning', 'passkeys_unreachable', { settingKey: 'AUTHENTIK_URL' });
    default: break;
  }
  if (lc.passkeySignIn === 'no_stage') return bad(id, 'warning', 'passkeys_no_stage', { href: LOGIN_CARD });
  if (lc.passkeySignIn === 'rp_mismatch') return bad(id, 'warning', 'passkeys_rp_mismatch', { href: LOGIN_CARD });
  if (lc.passkeySignIn === 'ok' && lc.passkeyUv !== 'required') return bad(id, 'warning', 'passkeys_uv_not_required', { href: LOGIN_CARD });
  return line(id, 'ok');
}

/** mail is checked as "the recovery flow has an e-mail stage"; delivery itself is never tested (that would send a mail) */
function mailLine(cfg: Config, lc: LoginCheck): CheckLine {
  const id = 'signin.mail';
  if (noApi(lc)) return bad(id, 'not_set_up', 'authentik_not_set', { settingKey: apiKey(cfg) });
  if (flowsUnread(lc)) return bad(id, 'unknown', 'flows_unchecked', { href: LOGIN_CARD });
  const recovery = lc.flows.find((f) => f.kind === 'recovery');
  if (recovery && recovery.state !== 'missing' && recovery.stages.includes(EMAIL_STAGE)) return line(id, 'ok', { cause: 'mail_unverified' });
  return bad(id, 'warning', 'mail_no_stage', { href: LOGIN_CARD });
}

export const signinCheck: GroupCheck = {
  group: 'signin',
  ids: ['signin.oidc', 'signin.authentik', 'signin.flows', 'signin.issuerHost', 'signin.passkeys', 'signin.mail'],
  timeoutMs: SIGNIN_TIMEOUT_MS,
  async run(env) {
    const [s, lc] = await Promise.all([env.snapshot(), env.login()]);
    const cfg = env.ctx.cfg;
    return [oidcLine(s), authentikLine(cfg, lc), flowsLine(cfg, lc), issuerLine(cfg, lc), passkeysLine(lc), mailLine(cfg, lc)];
  },
};
