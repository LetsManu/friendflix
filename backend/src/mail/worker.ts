// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Transporter } from 'nodemailer';
import { decrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import type { Db } from '../db.js';
import { isLanguage } from '../i18n.js';
import { HttpError } from '../users.js';
import { mailBrand } from './brand.js';
import { BACKOFF_S, LIMITS, MAX_ATTEMPTS } from './outbox.js';
import { isMailPrefType, personMailBlock } from './people.js';
import { renderMail, type MailKind } from './templates.js';
import { classifyMailError, createMailTransport, mailConfigured, type MailFailure } from './transport.js';

/**
 * The background sender (docs/superpowers/specs/2026-11-16-mail-design.md, "Outbox"). A tick expires mail queued for 72 h, deletes
 * final rows 30 days after they ended, then claims up to 20 due rows (`for update skip locked` and a 2-minute lease, so two instances
 * never send a mail twice; a lease that ran out is claimed again) and sends them over one pooled connection, closed when the tick ends.
 *
 * - A message-class 4xx or an unknown error retries after 1 min, 5 min, 30 min, 2 h, 6 h; the 6th failed attempt is final. A 5xx is final
 *   at once.
 * - A transport-class error (unreachable, timeout, tls, auth) is nobody's message's fault: the tick gives back the rows it has not sent
 *   (attempts − 1), waits by the backoff of consecutive transport failures (kv `mail:transport:fails`) and stops.
 * - A row over a rate limit goes back without an attempt counted, due when the oldest counted mail leaves the window.
 * - A person mail (welcome or a per-type mail, with its user) is checked once more right before the send: an account disabled or
 *   expired since it was queued, an admin alert whose recipient is no longer an admin, an address changed or removed since, or a type
 *   switched off since, deletes the row unsent and logs its code (`inactive`, `not_admin`, `address_changed`, `unsubscribed`; see
 *   `dropUnwanted`). An invitation mail whose invite is revoked, expired or used up is deleted unsent too (`housekeeping`).
 *
 * Times come from the database clock (or the caller's `now`), so next_at and created_at compare on one clock. Log lines carry the row
 * id and a code only; never an address, a text or the server's reply.
 */

export interface MailLog { warn(o: { mail: string; code: string }, msg?: string): void }
const consoleLog: MailLog = { warn: (o, msg) => console.warn(msg ?? 'mail', JSON.stringify(o)) };

export interface TickResult { sent: number; failed: number; deferred: number }
export interface DeliverResult { state: 'sent' | 'queued' | 'failed'; code?: string; smtp?: number }

/** the monotonic clock (ms) that measures how much of a claim's lease is left; tests replace it */
const monotonic = () => performance.now();
let clock: () => number = monotonic;
/** Tests only: a monotonic clock in ms (null restores performance.now). */
export function setMailClockForTests(fn: (() => number) | null): void {
  clock = fn ?? monotonic;
}

const LEASE_MS = 2 * 60_000;
/** the lease one more send may need (more than one 30 s socket timeout): with less left, the batch stops and gives back the rest */
const SEND_BUDGET_MS = 45_000;
const BATCH = 20;
const TRANSPORT_FAILS_TTL_S = 86_400;
const TRANSPORT_TTL_S = 7 * 86_400;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

interface Claimed {
  id: string; kind: string; user_id: string | null; rcpt_enc: string | null; rcpt_key: string; params_enc: string | null; lang: string; attempts: number;
}
type Outcome = DeliverResult;

/** the database clock, rounded up to the next millisecond (a Date has no microseconds: rounded down, a row queued in the same
 *  millisecond would not be due yet) */
const dbNow = async (db: Db) =>
  new Date(Number((await db.query<{ ms: string }>('select ceil(extract(epoch from now()) * 1000)::bigint ms')).rows[0]!.ms));
const later = (now: Date, s: number) => new Date(now.getTime() + s * 1000);
/** the wait after the n-th failure in a row (1-based), the last step repeating */
const backoff = (n: number) => BACKOFF_S[Math.min(Math.max(n, 1), BACKOFF_S.length) - 1]!;

/**
 * expiry (72 h queued), retention (30 days after the end), and invitation mails whose invite closed while they waited (revoked, expired
 * or used up: the link in it is dead). Those are deleted unsent, like a person mail nobody wants any more (see `dropUnwanted`).
 */
async function housekeeping(db: Db, now: Date, log: MailLog): Promise<void> {
  const closed = await db.query<{ id: string }>(
    `delete from mail_outbox o where o.kind = 'invite' and o.state = 'queued'
        and not exists (select 1 from invites i where o.dedupe = 'invite:' || i.id and i.uses < i.max_uses and i.expires_at > $1)
      returning id`, [now]);
  for (const r of closed.rows) log.warn({ mail: r.id, code: 'invite_closed' }, 'mail dropped');
  const expired = await db.query<{ id: string }>(
    `update mail_outbox set state = 'failed', last_code = 'expired', last_smtp = null, finished_at = $1, lease_until = null,
            rcpt_enc = null, params_enc = null
      where (state = 'queued' or (state = 'sending' and lease_until < $1)) and created_at < $1::timestamptz - interval '72 hours'
      returning id`, [now]);
  for (const r of expired.rows) log.warn({ mail: r.id, code: 'expired' }, 'mail expired');
  await db.query("delete from mail_outbox where state in ('sent','failed') and finished_at < $1::timestamptz - interval '30 days'", [now]);
}

/**
 * claims due rows (or the one row `id`, due or not) under a lease ending at `lease`, oldest due first (an update's `returning` has
 * no order of its own: it follows where the rows happen to lie in the table)
 */
async function claim(db: Db, now: Date, lease: Date, id?: string): Promise<Claimed[]> {
  const due = id === undefined
    ? "((state = 'queued' and next_at <= $1) or (state = 'sending' and lease_until < $1))"
    : "id = $3 and (state = 'queued' or (state = 'sending' and lease_until < $1))";
  const r = await db.query<Claimed>(
    `with c as (
       update mail_outbox set state = 'sending', lease_until = $2, attempts = attempts + 1
        where id in (select id from mail_outbox where ${due} order by next_at limit ${BATCH} for update skip locked)
        returning id, kind, user_id, rcpt_enc, rcpt_key, params_enc, lang, attempts, next_at, created_at)
     select id, kind, user_id, rcpt_enc, rcpt_key, params_enc, lang, attempts from c order by next_at, created_at, id`,
    id === undefined ? [now, lease] : [now, lease, id]);
  return r.rows;
}

/** null when the row may go now; else when the window of the limit it is over frees up */
async function rateWait(db: Db, rcptKey: string, now: Date): Promise<Date | null> {
  const r = (await db.query<{ rh: string; rh_old: Date | null; rd: string; rd_old: Date | null; ih: string; ih_old: Date | null }>(
    `select count(*) filter (where rcpt_key = $1 and sent_at > $2::timestamptz - interval '1 hour') rh,
            min(sent_at) filter (where rcpt_key = $1 and sent_at > $2::timestamptz - interval '1 hour') rh_old,
            count(*) filter (where rcpt_key = $1) rd,
            min(sent_at) filter (where rcpt_key = $1) rd_old,
            count(*) filter (where sent_at > $2::timestamptz - interval '1 hour') ih,
            min(sent_at) filter (where sent_at > $2::timestamptz - interval '1 hour') ih_old
       from mail_outbox where state = 'sent' and sent_at > $2::timestamptz - interval '1 day'`, [rcptKey, now])).rows[0]!;
  const waits: number[] = [];
  if (Number(r.rh) >= LIMITS.perRcptHour && r.rh_old) waits.push(r.rh_old.getTime() + HOUR_MS);
  if (Number(r.rd) >= LIMITS.perRcptDay && r.rd_old) waits.push(r.rd_old.getTime() + DAY_MS);
  if (Number(r.ih) >= LIMITS.instanceHour && r.ih_old) waits.push(r.ih_old.getTime() + HOUR_MS);
  return waits.length ? new Date(Math.max(...waits)) : null;
}

/** each update applies only while this tick still holds the row's lease */
const OWNED = "id = $1 and state = 'sending' and lease_until = $2";

const markSent = (db: Db, r: Claimed, lease: Date, now: Date) => db.query(
  `update mail_outbox set state = 'sent', sent_at = $3, finished_at = $3, lease_until = null, rcpt_enc = null, params_enc = null
    where ${OWNED}`, [r.id, lease, now]);
const markFailed = (db: Db, r: Claimed, lease: Date, now: Date, code: string, smtp: number | null) => db.query(
  `update mail_outbox set state = 'failed', last_code = $4, last_smtp = $5, finished_at = $3, lease_until = null, rcpt_enc = null,
          params_enc = null
    where ${OWNED}`, [r.id, lease, now, code, smtp]);
const markRetry = (db: Db, r: Claimed, lease: Date, next: Date, code: string, smtp: number | null) => db.query(
  `update mail_outbox set state = 'queued', last_code = $4, last_smtp = $5, next_at = $3, lease_until = null where ${OWNED}`,
  [r.id, lease, next, code, smtp]);
/** back to the queue without an attempt counted (a rate limit, a transport failure, the lease running short); next null keeps next_at */
const giveBack = (db: Db, ids: string[], lease: Date, next: Date | null) => db.query(
  `update mail_outbox set state = 'queued', attempts = greatest(attempts - 1, 0), next_at = coalesce($3, next_at), lease_until = null
    where id = any($1) and state = 'sending' and lease_until = $2`, [ids, lease, next]);

const withSmtp = (o: Outcome, smtp: number | null): Outcome => (smtp === null ? o : { ...o, smtp });

/**
 * The last check of a person mail before it goes out: a code when its person no longer wants or may get it, or no longer has the
 * address it was queued for, and then the row is deleted (still under this tick's lease). It closes the race with the enqueue (which
 * read the switch before the person turned it off; setMailPref only deletes rows that are queued by then), with a switch turned off
 * while the row waited, with an admin demoted while an alert waited (`not_admin`), and with an address changed while it waited (the
 * old address must never get it). Deleted, not `failed`: nothing went wrong with the mail system, so it must not count as a failure
 * in the status or the Systemcheck, and the end state is the one setMailPref gives a row it reaches in time. The admin's test mail
 * and the invitation are not person mails.
 */
async function dropUnwanted(ctx: Pick<Ctx, 'db' | 'encKey'>, r: Claimed, lease: Date): Promise<string | null> {
  if (!r.user_id || (r.kind !== 'welcome' && !isMailPrefType(r.kind))) return null;
  const { db } = ctx;
  const code = await personMailBlock(ctx, r.user_id, r.kind, r.rcpt_key);
  if (code) await db.query(`delete from mail_outbox where ${OWNED}`, [r.id, lease]);
  return code;
}

/** the claim's lease: its value (the fence of every update) and when it ends on the monotonic clock */
interface Lease { until: Date; endsAt: number }

/**
 * Sends the claimed rows over one connection; the outcome of every row it got to. Before each send it checks the lease: a send may take
 * longer than one socket timeout, and once the lease has run out another instance may claim and send the same row, so with less than
 * SEND_BUDGET_MS left the rest of the batch goes back unchanged (still due) and the tick stops.
 */
async function sendClaimed(ctx: Ctx, rows: Claimed[], transport: Transporter, now: Date, l: Lease, log: MailLog): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  const { db } = ctx;
  const lease = l.until;
  const from = { name: (await mailBrand(ctx)).name, address: ctx.cfg.MAIL_FROM! };
  let cleared = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (l.endsAt - clock() < SEND_BUDGET_MS) {
      const rest = rows.slice(i).map((x) => x.id);
      await giveBack(db, rest, lease, null);
      for (const id of rest) out.set(id, { state: 'queued' });
      break;
    }
    if (r.attempts > MAX_ATTEMPTS) {
      // claimed again after its last attempt (a worker died while sending it, more than once): no further try
      await markFailed(db, r, lease, now, 'unexpected', null);
      log.warn({ mail: r.id, code: 'unexpected' }, 'mail failed');
      out.set(r.id, { state: 'failed', code: 'unexpected' });
      continue;
    }
    const wait = await rateWait(db, r.rcpt_key, now);
    if (wait) {
      await giveBack(db, [r.id], lease, wait);
      out.set(r.id, { state: 'queued', code: 'rate_limited' });
      continue;
    }
    const dropped = await dropUnwanted(ctx, r, lease);
    if (dropped) {
      log.warn({ mail: r.id, code: dropped }, 'mail dropped');
      continue;
    }
    let to: string;
    let params: Record<string, unknown>;
    try {
      to = decrypt(ctx.encKey, r.rcpt_enc ?? '');
      params = JSON.parse(decrypt(ctx.encKey, r.params_enc ?? '')) as Record<string, unknown>;
    } catch {
      // encrypted with another APP_ENC_KEY (or damaged): no retry can read it
      await markFailed(db, r, lease, now, 'unreadable', null);
      log.warn({ mail: r.id, code: 'unreadable' }, 'mail failed');
      out.set(r.id, { state: 'failed', code: 'unreadable' });
      continue;
    }
    let f: MailFailure | null = null;
    try {
      const m = await renderMail(ctx, r.kind as MailKind, isLanguage(r.lang) ? r.lang : 'de', params, { userId: r.user_id });
      // `from` as an address object: nodemailer quotes or encodes the brand name, so it can never add a header or a recipient
      await transport.sendMail({ from, to, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments, headers: m.headers });
    } catch (e) {
      f = classifyMailError(e);
    }
    if (!f) {
      // outside the classifying try: a store error after the send must never turn a sent mail into a retry
      await markSent(db, r, lease, now);
      out.set(r.id, { state: 'sent' });
      if (!cleared) {
        cleared = true;
        // best effort: the status shows the old transport failure until the next send clears it
        await Promise.all([ctx.kv.del('mail:transport'), ctx.kv.del('mail:transport:fails')]).catch(() => undefined);
      }
      continue;
    }
    if (f.scope === 'transport' && f.code !== 'unexpected') {
      // nothing is wrong with the messages: this one and the rest go back without using an attempt, and the tick stops
      const fails = await ctx.kv.incr('mail:transport:fails', TRANSPORT_FAILS_TTL_S);
      await ctx.kv.set('mail:transport', JSON.stringify({ code: f.code, at: now.toISOString() }), TRANSPORT_TTL_S);
      const rest = rows.slice(i).map((x) => x.id);
      await giveBack(db, rest, lease, later(now, backoff(fails)));
      for (const id of rest) out.set(id, withSmtp({ state: 'queued', code: f.code }, f.smtp));
      log.warn({ mail: r.id, code: f.code }, 'mail transport failed');
      break;
    }
    log.warn({ mail: r.id, code: f.code }, 'mail failed');
    if (f.permanent || r.attempts >= MAX_ATTEMPTS) {
      await markFailed(db, r, lease, now, f.code, f.smtp);
      out.set(r.id, withSmtp({ state: 'failed', code: f.code }, f.smtp));
    } else {
      await markRetry(db, r, lease, later(now, backoff(r.attempts)), f.code, f.smtp);
      out.set(r.id, withSmtp({ state: 'queued', code: f.code }, f.smtp));
    }
  }
  return out;
}

/**
 * One pass: housekeeping, then claim and send. Not configured: housekeeping only. A configuration the transport refuses
 * (`insecure_auth`, `no_user`: a password without a user) is recorded in kv `mail:transport` and nothing is claimed.
 */
async function run(ctx: Ctx, now: Date | undefined, log: MailLog, id?: string): Promise<{ outcomes: Map<string, Outcome>; blocked?: string }> {
  // the monotonic start comes before the database time is read: the lease (anchored at `at`) is never counted longer than it is
  const t0 = clock();
  const at = now ?? await dbNow(ctx.db);
  await housekeeping(ctx.db, at, log);
  if (!mailConfigured(ctx.cfg)) return { outcomes: new Map(), blocked: 'not_configured' };
  let transport: Transporter;
  try {
    transport = createMailTransport(ctx.cfg);
  } catch (e) {
    const { code } = classifyMailError(e);
    await ctx.kv.set('mail:transport', JSON.stringify({ code, at: at.toISOString() }), TRANSPORT_TTL_S);
    return { outcomes: new Map(), blocked: code };
  }
  try {
    const lease: Lease = { until: new Date(at.getTime() + LEASE_MS), endsAt: t0 + LEASE_MS };
    const rows = await claim(ctx.db, at, lease.until, id);
    return { outcomes: rows.length ? await sendClaimed(ctx, rows, transport, at, lease, log) : new Map() };
  } finally {
    transport.close();
  }
}

/** The background tick (server.ts, every 30 s where BACKGROUND_JOBS=true). Failures: rows that failed for good in this tick. */
export async function mailTick(ctx: Ctx, now?: Date, log: MailLog = consoleLog): Promise<TickResult> {
  const res: TickResult = { sent: 0, failed: 0, deferred: 0 };
  for (const o of (await run(ctx, now, log)).outcomes.values()) {
    if (o.state === 'sent') res.sent++;
    else if (o.state === 'failed') res.failed++;
    else res.deferred++;
  }
  return res;
}

/** Sends one row now through the same claim and send path (the test mail: the admin gets an answer). */
export async function deliverNow(ctx: Ctx, id: string, o: { now?: Date; log?: MailLog } = {}): Promise<DeliverResult> {
  const { outcomes, blocked } = await run(ctx, o.now, o.log ?? consoleLog, id);
  const done = outcomes.get(id);
  if (done) return done;
  // not claimed: already final, held by another worker's lease, or the transport cannot be used
  const r = (await ctx.db.query<{ state: string; last_code: string | null; last_smtp: number | null }>(
    'select state, last_code, last_smtp from mail_outbox where id = $1', [id])).rows[0];
  if (!r) throw new HttpError(404, 'not_found');
  if (r.state === 'sent') return { state: 'sent' };
  if (r.state === 'failed') return withSmtp({ state: 'failed', code: r.last_code ?? 'unexpected' }, r.last_smtp);
  return blocked ? { state: 'queued', code: blocked } : { state: 'queued' };
}
