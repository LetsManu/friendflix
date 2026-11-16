// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Einstellungen → E-Mail (backend/src/mail/routes.ts): the status line (GET /api/admin/mail/status) and *Testmail senden*
 * (POST /api/admin/mail/test, always to the signed-in admin's own address). Both answers carry codes, counts and times only, never an
 * address or a server text; every code becomes a sentence here (`settings.mail.code.*`), an unknown one the generic sentence.
 */
import { api, ApiError } from '#lib/api';
import { hasKey, trDynamic, type TParams } from '#lib/i18n';

export interface MailStatus {
  configured: boolean;
  /** rows waiting or being sent */
  queued: number;
  /** rows that failed for good in the last 24 h */
  failed24h: number;
  lastSentAt: string | null;
  lastFailure: { kind: string; code: string; smtp: number | null; at: string } | null;
  /** the last transport failure (cleared by the next good send or probe) */
  transport: { code: string; at: string } | null;
}
export interface TestMailResult { state: 'sent' | 'queued' | 'failed'; code?: string; smtp?: number }
export type Translate = (key: string, params?: TParams) => string;
export type ResultTone = 'ok' | 'warn' | 'err';

export const loadMailStatus = (): Promise<MailStatus> => api<MailStatus>('/api/admin/mail/status');
export const sendTestMail = (): Promise<TestMailResult> => api<TestMailResult>('/api/admin/mail/test', { method: 'POST' });

const CODE = /^[a-z][a-z0-9_]{0,59}$/;
const codeKey = (code: string) => (CODE.test(code) && hasKey(`settings.mail.code.${code}`) ? `settings.mail.code.${code}` : 'settings.mail.code.unexpected');

/** a delivery or transport code as a short sentence, with the SMTP status when there is one: "… (SMTP 550)" */
export function mailCodeText(code: string, smtp?: number | null, tr: Translate = trDynamic): string {
  const reason = tr(codeKey(code));
  return typeof smtp === 'number' && smtp > 0 ? tr('settings.mail.withSmtp', { reason, smtp: String(smtp) }) : reason;
}

/**
 * The status line: not configured → what to fill in; else when the last mail went out, how many wait, the last final failure and the
 * last transport failure (each with its time). The parts are joined with " · ".
 */
export function statusLine(s: MailStatus, tr: Translate, fmtDate: (iso: string) => string): string {
  if (!s.configured) return tr('settings.mail.notConfigured');
  const parts = [s.lastSentAt ? tr('settings.mail.lastSent', { when: fmtDate(s.lastSentAt) }) : tr('settings.mail.neverSent')];
  if (s.queued > 0) parts.push(tr('settings.mail.queuedCount', { n: s.queued }));
  const f = s.lastFailure;
  if (f) parts.push(tr('settings.mail.lastFailure', { reason: mailCodeText(f.code, f.smtp, tr), when: fmtDate(f.at) }));
  if (s.transport) parts.push(tr('settings.mail.transport', { reason: mailCodeText(s.transport.code, null, tr), when: fmtDate(s.transport.at) }));
  return parts.join(' · ');
}

const ROUTE_ERRORS: Record<string, { key: string; tone: ResultTone }> = {
  mail_not_configured: { key: 'settings.mail.notConfigured', tone: 'warn' },
  no_address: { key: 'settings.mail.noAddress', tone: 'warn' },
  rate_limited: { key: 'settings.mail.rateLimited', tone: 'warn' },
  forbidden: { key: 'settings.mail.forbidden', tone: 'err' },
};

/** the code of a refused test call: the body's `error`, else the status's meaning */
export function testError(e: unknown): { error: string } {
  if (!(e instanceof ApiError)) return { error: 'failed' };
  const c = (e.body as { error?: unknown } | null)?.error;
  if (typeof c === 'string' && CODE.test(c)) return { error: c };
  return { error: e.status === 429 ? 'rate_limited' : e.status === 403 ? 'forbidden' : 'failed' };
}

/** The result line of *Testmail senden*: sent (ok), queued and retried (warn), failed or refused (err / warn). */
export function testResultText(r: TestMailResult | { error: string }, tr: Translate): { tone: ResultTone; text: string } {
  if ('error' in r) {
    const known = Object.prototype.hasOwnProperty.call(ROUTE_ERRORS, r.error) ? ROUTE_ERRORS[r.error] : undefined;
    return known ? { tone: known.tone, text: tr(known.key) } : { tone: 'err', text: tr('settings.mail.testFailed') };
  }
  if (r.state === 'sent') return { tone: 'ok', text: tr('settings.mail.sent') };
  // queued without a code: held by another sender's lease, it goes out with the next round
  if (r.state === 'queued') return { tone: 'warn', text: r.code ? tr('settings.mail.queued', { code: tr(codeKey(r.code)) }) : tr('settings.mail.queuedLater') };
  return { tone: 'err', text: tr('settings.mail.failed', { reason: mailCodeText(r.code ?? 'unexpected', r.smtp, tr) }) };
}
