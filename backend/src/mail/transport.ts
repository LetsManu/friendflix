// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import nodemailer, { type SMTPPoolOptions, type Transporter } from 'nodemailer';
import type { Config } from '../config.js';
import { fail, OK, type ProbeResult } from '../settings/probeKit.js';

/**
 * The SMTP transport (docs/superpowers/specs/2026-11-16-mail-design.md, "Transport"): nodemailer options built from the live config,
 * with logging off (nodemailer's debug output carries the base64 AUTH exchange) and certificates always verified (TLS 1.2 or newer).
 * starttls requires the upgrade, so a server without STARTTLS fails with `tls` before any login; `none` never logs in. Errors leave
 * this module as codes and the 3-digit SMTP status only: the server's reply text (which may quote an address) is never passed on.
 */
export type MailErrorCode = 'not_configured' | 'insecure_auth' | 'unreachable' | 'timeout' | 'tls' | 'auth' | 'sender_refused'
  | 'recipient_refused' | 'message_refused' | 'unexpected';

/** transport: nothing is wrong with the message (try again later); message: this message was refused (5xx permanent, 4xx retried) */
export interface MailFailure { code: MailErrorCode; smtp: number | null; scope: 'transport' | 'message'; permanent: boolean }

export class MailError extends Error {
  constructor(readonly failure: MailFailure) {
    super(failure.code);
    this.name = 'MailError';
  }
}

const SEND_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 };
const PROBE_TIMEOUT_MS = 5_000;

let testCa: string | null = null;
/** Tests only: trusts the test server's self-signed certificate (adds `tls.ca`); null restores the system trust store. */
export function setMailTestCa(pem: string | null): void {
  testCa = pem;
}

/** Host and sender are set (a relay may need no login). */
export function mailConfigured(cfg: Config): boolean {
  return Boolean(cfg.MAIL_SMTP_HOST && cfg.MAIL_FROM);
}

const failure = (code: MailErrorCode, smtp: number | null = null, scope: MailFailure['scope'] = 'transport', permanent = false): MailFailure =>
  ({ code, smtp, scope, permanent });

/** The EHLO name: the host of PUBLIC_URL (the container's own name is a random id some servers refuse), else a reserved name. */
function ehloName(cfg: Config): string {
  try {
    if (cfg.PUBLIC_URL) return new URL(cfg.PUBLIC_URL).hostname;
  } catch {
    // falls through
  }
  return 'friendflix.invalid';
}

/**
 * nodemailer options for the current config: one pooled connection per tick (`maxMessages` 50; the caller closes it at the end), send
 * timeouts 10 / 10 / 30 s, the probe's 5 s each (or the caller's smaller limit). Throws MailError `not_configured` / `insecure_auth`.
 */
export function transportOptions(cfg: Config, o: { probe?: boolean; timeoutMs?: number } = {}): SMTPPoolOptions & { pool: true } {
  if (!mailConfigured(cfg)) throw new MailError(failure('not_configured'));
  const mode = cfg.MAIL_SMTP_TLS;
  const login = Boolean(cfg.MAIL_SMTP_USER || cfg.MAIL_SMTP_PASSWORD);
  // never a password in clear: a plain relay is used without login only
  if (mode === 'none' && login) throw new MailError(failure('insecure_auth'));
  const t = o.probe ? Math.min(PROBE_TIMEOUT_MS, o.timeoutMs ?? PROBE_TIMEOUT_MS) : undefined;
  return {
    host: cfg.MAIL_SMTP_HOST,
    port: cfg.MAIL_SMTP_PORT,
    secure: mode === 'tls',
    requireTLS: mode === 'starttls',
    ignoreTLS: mode === 'none',
    tls: { minVersion: 'TLSv1.2', ...(testCa ? { ca: testCa } : {}) },
    name: ehloName(cfg),
    ...(cfg.MAIL_SMTP_USER ? { auth: { user: cfg.MAIL_SMTP_USER, pass: cfg.MAIL_SMTP_PASSWORD ?? '' } } : {}),
    ...(t === undefined ? SEND_TIMEOUTS : { connectionTimeout: t, greetingTimeout: t, socketTimeout: t }),
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    logger: false,
    debug: false,
    // a message is built from strings and buffers only: never from a path or a URL
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createMailTransport(cfg: Config, o: { probe?: boolean; timeoutMs?: number } = {}): Transporter {
  return nodemailer.createTransport(transportOptions(cfg, o));
}

type SmtpErr = { code?: unknown; originalCode?: unknown; command?: unknown; responseCode?: unknown; message?: unknown };
/** a TLS failure that surfaces as a socket error (an untrusted or expired certificate, a handshake alert) */
const TLS_CODE = /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|HOSTNAME|EPROTO/;
const TLS_TEXT = /certificate|\bTLS\b|\bSSL\b|handshake/i;

/** The class of a send or verify error. Reads code, command and status (and the message for TLS detection only); returns codes only. */
export function classifyMailError(e: unknown): MailFailure {
  if (e instanceof MailError) return e.failure;
  if (!e || typeof e !== 'object') return failure('unexpected');
  const err = e as SmtpErr;
  const code = typeof err.code === 'string' ? err.code : '';
  const command = typeof err.command === 'string' ? err.command : '';
  const status = typeof err.responseCode === 'number' && err.responseCode >= 200 && err.responseCode <= 599 ? err.responseCode : null;
  const message = (scope: 'sender_refused' | 'recipient_refused' | 'message_refused') =>
    failure(scope, status, 'message', status === null || status >= 500);
  switch (code) {
    case 'EAUTH': case 'ENOAUTH': return failure('auth', status);
    case 'ETIMEDOUT': return failure('timeout', status);
    case 'ETLS': return failure('tls', status);
    case 'EENVELOPE':
      if (command.startsWith('MAIL FROM')) return message('sender_refused');
      if (command.startsWith('RCPT TO')) return message('recipient_refused');
      if (command.startsWith('DATA')) return message('message_refused');
      // nodemailer's own check of the envelope before sending (no recipient, an address it cannot use): retrying cannot help
      return command === 'API' ? message('message_refused') : failure('unexpected', status);
    case 'EMESSAGE': return message('message_refused');
    case 'ESOCKET': case 'ECONNECTION': case 'EDNS': {
      const original = typeof err.originalCode === 'string' ? err.originalCode : '';
      if (TLS_CODE.test(original) || (typeof err.message === 'string' && TLS_TEXT.test(err.message))) return failure('tls', status);
      return failure('unreachable', status);
    }
    default: return failure('unexpected', status);
  }
}

/** The connection probe: connect, TLS and login (`verify()`), never a send; the connection is closed either way. */
export async function probeMail(cfg: Config, o: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  let transport: Transporter | undefined;
  try {
    transport = createMailTransport(cfg, { probe: true, timeoutMs: o.timeoutMs });
    await transport.verify();
    return OK;
  } catch (e) {
    const { code } = classifyMailError(e);
    switch (code) {
      case 'not_configured': return fail('invalid', 'not_set');
      case 'insecure_auth': return fail('invalid', 'insecure_auth');
      case 'auth': return fail('unauthorized');
      case 'tls': return fail('invalid', 'tls');
      case 'timeout': return fail('timeout');
      default: return fail('unreachable');
    }
  } finally {
    transport?.close();
  }
}
