// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import { mailSubkey } from '../../mail/address.js';
import { clearMailTransport, mailStatus } from '../../mail/outbox.js';
import { mailConfigured } from '../../mail/transport.js';
import { runProbe, type ProbeResult } from '../../settings/probes.js';
import type { CheckEnv, GroupCheck } from '../engine.js';
import { bad, line } from '../line.js';
import { CHECK_TIMEOUT_MS, type CheckLine } from '../types.js';

/**
 * E-Mail-Versand (core.mail, spec "Admin surface"): the connection probe (connect, TLS and login, never a send) cached in kv for 10
 * minutes so a Systemcheck view does not log in to the provider every minute (Jetzt prüfen probes again), then the outbox: a final
 * failure in the last 24 h, mail overdue for more than 15 minutes (a row waiting for its backoff or a rate limit is not overdue).
 * Codes only; the settings the probe ran against are part of the cache entry, so a changed setting is never answered from an old
 * result.
 */
const ID = 'core.mail';
const PROBE_KEY = 'mail:probe';
const PROBE_TTL_S = 600;
const PROBE_MS = 3_500;
const DAY_MS = 86_400_000;
const STUCK_MS = 900_000;
const HREF = '/admin/settings?tab=notifications';
const DOCS = 'mail.md';

/** one id per process: an .env change (a new password included) only takes effect with a restart, which starts with a fresh id */
const BOOT = randomUUID();
/**
 * What the cached probe result depends on, never the password itself: the non-secret mail settings, whether a password is set, the
 * settings revision (every saved change bumps it, a new password included) and the process (for .env changes). HMAC keyed with
 * the probe subkey of APP_ENC_KEY (mailSubkey(…, 'probe')) so the kv value says nothing about the settings.
 */
export const probeFingerprint = (key: Buffer, c: Config, rev: number) => createHmac('sha256', key)
  .update(JSON.stringify([c.MAIL_SMTP_HOST, c.MAIL_SMTP_PORT, c.MAIL_SMTP_TLS, c.MAIL_SMTP_USER, c.MAIL_FROM, Boolean(c.MAIL_SMTP_PASSWORD), rev, BOOT])).digest('hex');

function parseCached(raw: string | null, fp: string, now: number): ProbeResult | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { at?: unknown; fp?: unknown; r?: ProbeResult };
    if (v.fp !== fp || typeof v.at !== 'number' || now - v.at >= PROBE_TTL_S * 1000 || now < v.at || typeof v.r?.code !== 'string') return null;
    return { ok: v.r.ok === true, code: v.r.code, ...(typeof v.r.detail === 'string' ? { detail: v.r.detail } : {}) };
  } catch {
    return null;
  }
}

async function probe(env: CheckEnv): Promise<ProbeResult> {
  const { ctx } = env;
  const fp = probeFingerprint(mailSubkey(ctx.encKey, 'probe'), ctx.cfg, ctx.settings.rev());
  if (!env.fresh) {
    const hit = parseCached(await ctx.kv.get(PROBE_KEY).catch(() => null), fp, Date.now());
    if (hit) return hit;
  }
  const r = await runProbe(ctx, 'mail', ctx.cfg, { timeoutMs: PROBE_MS });
  await ctx.kv.set(PROBE_KEY, JSON.stringify({ at: Date.now(), fp, r }), PROBE_TTL_S).catch(() => undefined);
  // a connection that works again is no longer a failing one
  if (r.ok) await clearMailTransport(ctx);
  return r;
}

function probeLine(r: ProbeResult): CheckLine | null {
  if (r.ok) return null;
  const o = { docs: DOCS };
  if (r.code === 'unauthorized') return bad(ID, 'problem', 'mail_auth', { settingKey: 'MAIL_SMTP_PASSWORD', ...o });
  if (r.code === 'invalid') {
    if (r.detail === 'not_set') return bad(ID, 'not_set_up', 'mail_not_set', { settingKey: 'MAIL_SMTP_HOST', ...o });
    if (r.detail === 'tls') return bad(ID, 'problem', 'mail_tls', { settingKey: 'MAIL_SMTP_TLS', ...o });
    // a password without a user: the login would be sent without it
    if (r.detail === 'no_user') return bad(ID, 'problem', 'mail_no_user', { settingKey: 'MAIL_SMTP_USER', ...o });
    return bad(ID, 'problem', 'mail_insecure_auth', { settingKey: 'MAIL_SMTP_TLS', ...o });
  }
  return bad(ID, 'problem', 'mail_unreachable', { settingKey: 'MAIL_SMTP_HOST', ...o });
}

async function mailLine(env: CheckEnv): Promise<CheckLine> {
  const { ctx } = env;
  if (!mailConfigured(ctx.cfg)) return bad(ID, 'not_set_up', 'mail_not_set', { settingKey: 'MAIL_SMTP_HOST', docs: DOCS });
  const r = await probe(env);
  const problem = probeLine(r);
  if (problem) return problem;
  const s = await mailStatus(ctx);
  const f = s.lastFailure;
  if (f && Date.now() - Date.parse(f.at) < DAY_MS) {
    return bad(ID, 'warning', 'mail_last_failed', { params: { code: f.code, ...(f.smtp !== null ? { smtp: f.smtp } : {}) }, href: HREF, docs: DOCS });
  }
  if (s.oldestOverdueAt && Date.now() - Date.parse(s.oldestOverdueAt) > STUCK_MS) return bad(ID, 'warning', 'mail_queue_stuck', { href: HREF, docs: DOCS });
  return line(ID, 'ok');
}

export const mailCheck: GroupCheck = {
  group: 'core',
  ids: [ID],
  timeoutMs: CHECK_TIMEOUT_MS,
  run: async (env) => [await mailLine(env)],
};
