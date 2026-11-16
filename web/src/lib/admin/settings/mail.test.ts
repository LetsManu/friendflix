// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api';
import { hasKey, setLocale, trDynamic } from '#lib/i18n';
import { PROBE_GROUPS } from './api';
import { probeText } from './form';
import { loadMailStatus, mailCodeText, sendTestMail, statusLine, testError, testResultText, type MailStatus } from './mail';

afterEach(async () => { vi.unstubAllGlobals(); await setLocale('de'); });

const tr = (k: string, p?: Record<string, string | number | null | undefined>) => trDynamic(k, p);
const when = (iso: string) => `[${iso}]`;
const status = (o: Partial<MailStatus> = {}): MailStatus => ({
  configured: true, queued: 0, failed24h: 0, lastSentAt: null, lastFailure: null, transport: null, ...o,
});

/** every delivery and transport code the backend can send (MailErrorCode plus the worker's own codes) */
const CODES = ['unreachable', 'timeout', 'tls', 'auth', 'sender_refused', 'recipient_refused', 'message_refused', 'expired', 'unexpected',
  'rate_limited', 'unreadable', 'not_configured', 'insecure_auth'];

describe('mail status line', () => {
  it('not configured: asks for server and sender', () => {
    expect(statusLine(status({ configured: false }), tr, when)).toBe('Trag Server und Absenderadresse ein und speichere.');
  });

  it('sent with no failure: the time of the last mail only', () => {
    const s = statusLine(status({ lastSentAt: '2026-11-16T09:00:00Z' }), tr, when);
    expect(s).toBe('Zuletzt gesendet: [2026-11-16T09:00:00Z]');
  });

  it('a failure with SMTP 550: its sentence, the status and the time', () => {
    const s = statusLine(status({
      lastSentAt: '2026-11-16T09:00:00Z',
      lastFailure: { kind: 'test', code: 'recipient_refused', smtp: 550, at: '2026-11-16T10:00:00Z' },
    }), tr, when);
    expect(s).toContain('Zuletzt gesendet: [2026-11-16T09:00:00Z]');
    expect(s).toContain(`Letzter Fehler: ${tr('settings.mail.code.recipient_refused')} (SMTP 550) ([2026-11-16T10:00:00Z])`);
    expect(s).toContain('550');
  });

  it('the queued count is a plural', () => {
    expect(statusLine(status({ queued: 1 }), tr, when)).toContain('1 E-Mail wartet');
    expect(statusLine(status({ queued: 3 }), tr, when)).toContain('3 E-Mails warten');
    expect(statusLine(status({ queued: 0 }), tr, when)).not.toContain('wart');
  });

  it('nothing sent yet, and a transport failure of its own', () => {
    expect(statusLine(status(), tr, when)).toBe(tr('settings.mail.neverSent'));
    const s = statusLine(status({ transport: { code: 'auth', at: '2026-11-16T11:00:00Z' } }), tr, when);
    expect(s).toContain(tr('settings.mail.transport', { reason: tr('settings.mail.code.auth'), when: '[2026-11-16T11:00:00Z]' }));
  });
});

describe('mail codes', () => {
  it('every code has a sentence; an unknown code gets the generic one, never the raw code', () => {
    for (const c of CODES) expect(hasKey(`settings.mail.code.${c}`), c).toBe(true);
    expect(mailCodeText('auth')).toBe(tr('settings.mail.code.auth'));
    expect(mailCodeText('auth', 535)).toBe(`${tr('settings.mail.code.auth')} (SMTP 535)`);
    expect(mailCodeText('no_such_code')).toBe(tr('settings.mail.code.unexpected'));
    expect(mailCodeText('Bad Code!')).toBe(tr('settings.mail.code.unexpected'));
  });
});

describe('test mail result', () => {
  it('sent → ok', () => {
    expect(testResultText({ state: 'sent' }, tr)).toEqual({ tone: 'ok', text: 'Testmail gesendet. Schau in dein Postfach.' });
  });

  it('queued → warn, naming the reason', () => {
    const r = testResultText({ state: 'queued', code: 'unreachable' }, tr);
    expect(r.tone).toBe('warn');
    expect(r.text).toBe(tr('settings.mail.queued', { code: tr('settings.mail.code.unreachable') }));
    expect(r.text).toContain('versucht es weiter');
    expect(testResultText({ state: 'queued' }, tr)).toEqual({ tone: 'warn', text: tr('settings.mail.queuedLater') });
  });

  it('failed → err, with the code sentence and the SMTP status', () => {
    const r = testResultText({ state: 'failed', code: 'auth', smtp: 535 }, tr);
    expect(r).toEqual({ tone: 'err', text: `Nicht gesendet: ${tr('settings.mail.code.auth')} (SMTP 535)` });
  });

  it('no_address → the account has no address', () => {
    expect(testResultText({ error: 'no_address' }, tr)).toEqual({ tone: 'warn', text: 'Dein Konto hat keine E-Mail-Adresse.' });
  });

  it('rate_limited → wait a little', () => {
    const r = testResultText({ error: 'rate_limited' }, tr);
    expect(r.tone).toBe('warn');
    expect(r.text).toBe(tr('settings.mail.rateLimited'));
  });

  it('the other route errors have sentences too', () => {
    expect(testResultText({ error: 'mail_not_configured' }, tr).text).toBe(tr('settings.mail.notConfigured'));
    expect(testResultText({ error: 'forbidden' }, tr)).toEqual({ tone: 'err', text: tr('settings.mail.forbidden') });
    expect(testResultText({ error: 'boom' }, tr)).toEqual({ tone: 'err', text: tr('settings.mail.testFailed') });
  });

  it('testError reads the code of a refused call', () => {
    expect(testError(new ApiError(400, { error: 'no_address' }))).toEqual({ error: 'no_address' });
    expect(testError(new ApiError(429, null))).toEqual({ error: 'rate_limited' });
    expect(testError(new ApiError(403, {}))).toEqual({ error: 'forbidden' });
    expect(testError(new Error('offline'))).toEqual({ error: 'failed' });
  });
});

describe('mail API', () => {
  it('GET status and POST test', async () => {
    const fetch = vi.fn(async (..._a: unknown[]) => ({ status: 200, ok: true, text: async () => JSON.stringify({ state: 'sent' }) }));
    vi.stubGlobal('fetch', fetch);
    await loadMailStatus();
    expect(await sendTestMail()).toEqual({ state: 'sent' });
    expect(fetch.mock.calls.map(([u, i]) => [u, (i as { method?: string }).method ?? 'GET'])).toEqual([
      ['/api/admin/mail/status', 'GET'], ['/api/admin/mail/test', 'POST'],
    ]);
  });
});

describe('mail settings texts', () => {
  it('the mail group has a Test button and labels for its six settings', () => {
    expect(PROBE_GROUPS.has('mail')).toBe(true);
    expect(tr('settings.groups.mail')).toBe('E-Mail');
    for (const k of ['MAIL_SMTP_HOST', 'MAIL_SMTP_PORT', 'MAIL_SMTP_TLS', 'MAIL_SMTP_USER', 'MAIL_SMTP_PASSWORD', 'MAIL_FROM']) {
      expect(hasKey(`settings.keys.${k}.label`), k).toBe(true);
    }
    for (const o of ['starttls', 'tls', 'none']) expect(hasKey(`settings.options.MAIL_SMTP_TLS.${o}`), o).toBe(true);
    expect(tr('settings.errors.invalid_email')).toBe('Keine gültige E-Mail-Adresse.');
  });

  it('the probe details of the mail check have sentences', () => {
    for (const d of ['insecure_auth', 'tls', 'no_user', 'not_set']) expect(hasKey(`settings.probeDetail.${d}`), d).toBe(true);
    expect(probeText({ ok: false, code: 'invalid', detail: 'no_user' })).toContain('Benutzername');
  });
});
