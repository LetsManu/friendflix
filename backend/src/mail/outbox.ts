// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { encrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import type { Language } from '../i18n.js';
import { HttpError } from '../users.js';
import { isMailAddress, maskAddress, recipientKey } from './address.js';
import type { MailKind } from './templates.js';
import { mailConfigured } from './transport.js';

/**
 * The durable outbox (docs/superpowers/specs/2026-11-16-mail-design.md, "Outbox"): a mail is a row in mail_outbox, sent by the
 * background worker (worker.ts). While queued, the address and the template params are encrypted with APP_ENC_KEY (an invite or
 * unsubscribe link carries a token, and a queued row must not be a readable copy of it); once final both are set to null and only
 * the kind, the masked address, state, codes and times stay. The mail is rendered at send time, in the language fixed here.
 */

/** the wait after the 1st … 5th failed attempt (seconds); the 6th failed attempt is final */
export const BACKOFF_S = [60, 300, 1800, 7200, 21600] as const;
export const MAX_ATTEMPTS = 6;
/** counted from the outbox's `sent` rows: per recipient per hour and per day, the whole instance per hour */
export const LIMITS = { perRcptHour: 10, perRcptDay: 50, instanceHour: 200 } as const;

export interface EnqueueInput {
  kind: MailKind;
  to: string;
  userId: string | null;
  lang: Language;
  params?: Record<string, unknown>;
  /** a unique key: a retried event never queues the same mail twice */
  dedupe?: string;
}

/** Queues a mail; the row id, or null when a row with the dedupe key exists. Needs no transport (a mail may wait for the setup). */
export async function enqueueMail(ctx: Pick<Ctx, 'db' | 'encKey'>, m: EnqueueInput): Promise<string | null> {
  if (!isMailAddress(m.to)) throw new HttpError(400, 'no_address');
  const id = randomUUID();
  const r = await ctx.db.query<{ id: string }>(
    `insert into mail_outbox (id, kind, user_id, rcpt_enc, rcpt_mask, rcpt_key, params_enc, lang, dedupe)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (dedupe) do nothing returning id`,
    [id, m.kind, m.userId, encrypt(ctx.encKey, m.to), maskAddress(m.to), recipientKey(ctx.encKey, m.to),
      encrypt(ctx.encKey, JSON.stringify(m.params ?? {})), m.lang, m.dedupe ?? null],
  );
  return r.rows[0]?.id ?? null;
}

export interface MailStatus {
  configured: boolean;
  /** rows waiting or being sent */
  queued: number;
  /** rows that failed for good in the last 24 h */
  failed24h: number;
  lastSentAt: string | null;
  lastFailure: { kind: string; code: string; smtp: number | null; at: string } | null;
  /** the last transport failure (cleared by the next successful send) */
  transport: { code: string; at: string } | null;
  oldestQueuedAt: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The admin's view of the outbox: counts, times and codes only, never an address or a text. */
export async function mailStatus(ctx: Pick<Ctx, 'db' | 'kv' | 'cfg'>): Promise<MailStatus> {
  const [counts, last, raw] = await Promise.all([
    ctx.db.query<{ queued: string; failed24h: string; last_sent: Date | null; oldest: Date | null }>(
      `select count(*) filter (where state in ('queued','sending')) queued,
              count(*) filter (where state = 'failed' and finished_at > now() - interval '24 hours') failed24h,
              max(sent_at) filter (where state = 'sent') last_sent,
              min(created_at) filter (where state in ('queued','sending')) oldest
         from mail_outbox`),
    ctx.db.query<{ kind: string; last_code: string | null; last_smtp: number | null; finished_at: Date }>(
      "select kind, last_code, last_smtp, finished_at from mail_outbox where state = 'failed' order by finished_at desc limit 1"),
    ctx.kv.get('mail:transport'),
  ]);
  const c = counts.rows[0]!;
  const f = last.rows[0];
  return {
    configured: mailConfigured(ctx.cfg),
    queued: Number(c.queued),
    failed24h: Number(c.failed24h),
    lastSentAt: iso(c.last_sent),
    lastFailure: f ? { kind: f.kind, code: f.last_code ?? 'unexpected', smtp: f.last_smtp, at: f.finished_at.toISOString() } : null,
    transport: parseTransport(raw),
    oldestQueuedAt: iso(c.oldest),
  };
}

function parseTransport(raw: string | null): MailStatus['transport'] {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { code?: unknown; at?: unknown };
    return typeof v.code === 'string' && typeof v.at === 'string' ? { code: v.code, at: v.at } : null;
  } catch {
    return null;
  }
}

/** A working connection was just seen (a good probe): the old transport failure and its backoff counter are history. Best effort. */
export async function clearMailTransport(ctx: Pick<Ctx, 'kv'>): Promise<void> {
  await Promise.all([ctx.kv.del('mail:transport'), ctx.kv.del('mail:transport:fails')]).catch(() => undefined);
}
