// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AkUpstreamError } from './akdiag.js';
import { audit } from './audit.js';
import { akBrandFor, akPatchBrand, akPatchEmailStage, akRecoveryEmailStage } from './authentik.js';
import { readBrand } from './brand/repo.js';
import { imageUrls } from './brand/routes.js';
import { publicOrigin, type Config } from './config.js';
import type { Ctx } from './ctx.js';
import { mailConfigured } from './mail/transport.js';
import { REAUTH_WINDOW_S, recentlyAuthenticated } from './reauth.js';
import { requireAdmin } from './session.js';
import { HttpError } from './users.js';

/**
 * Admin → Einstellungen → Benachrichtigungen, *Branding an Authentik übertragen* (mail stage C, Controller's calls 8 and 9): FriendFlix's
 * name and logo URL go into the Authentik brand of the sign-in host, the sender into the e-mail stage of the recovery flow, and the SMTP
 * settings only with `smtp: true` (an explicit tick, a sign-in at most 10 minutes old). Each part answers on its own; a failure of one
 * never stops the other. The SMTP password exists only in the stage PATCH body: never in an answer, an audit row, a log line or kv.
 * The permissions are not in the service account's blueprint (an optional action, least privilege); a refusal names the missing one.
 */
export type AkPartCode = 'permission' | 'token_invalid' | 'not_found' | 'no_email_stage' | 'unreachable' | 'error';
export type AkPart = { state: 'done' } | { state: 'skipped'; code: 'nothing_to_send' } | { state: 'failed'; code: AkPartCode; permission?: string };

/** the codenames of the three calls (Django's default permissions of the app labels `authentik_brands` and `authentik_stages_email`) */
export const AK_BRANDING_PERMS = {
  brandList: 'authentik_brands.view_brand',
  brandPatch: 'authentik_brands.change_brand',
  stagePatch: 'authentik_stages_email.change_emailstage',
} as const;

const SMTP_TIMEOUT_S = 10;

const configured = (cfg: Config) => Boolean(cfg.AUTHENTIK_URL && cfg.AUTHENTIK_API_TOKEN);

/** the host of OIDC_ISSUER (where Authentik shows its sign-in page), null for an unusable issuer */
function issuerHost(cfg: Config): string | null {
  try {
    return new URL(cfg.OIDC_ISSUER).hostname || null;
  } catch {
    return null;
  }
}

/** the brand's name and the absolute URL of its logo (else its symbol; null without either or without PUBLIC_URL) */
async function brandParts(ctx: Ctx): Promise<{ title: string; logoUrl: string | null }> {
  const { brand } = await readBrand(ctx.db);
  const origin = publicOrigin(ctx.cfg);
  const urls = await imageUrls(ctx.db, brand);
  const path = urls.logo ?? urls.symbol;
  return { title: brand.name, logoUrl: origin && path ? origin + path : null };
}

/**
 * What the card shows before anything is sent. Never the password (only whether a user is set); `available`: the Authentik API is
 * configured; `smtp.available`: mail is set up (the consent checkbox needs it). Authentik is not asked.
 */
export async function akBrandingPreview(ctx: Ctx): Promise<{
  available: boolean; title: string; logoUrl: string | null; from: string | null;
  smtp: { available: boolean; host: string | null; port: number; tls: 'starttls' | 'tls' | 'none'; hasUser: boolean };
}> {
  const c = ctx.cfg;
  const { title, logoUrl } = await brandParts(ctx);
  return {
    available: configured(c), title, logoUrl, from: c.MAIL_FROM ?? null,
    smtp: { available: mailConfigured(c), host: c.MAIL_SMTP_HOST ?? null, port: c.MAIL_SMTP_PORT, tls: c.MAIL_SMTP_TLS, hasUser: Boolean(c.MAIL_SMTP_USER) },
  };
}

/** a thrown Authentik error as a part; `permission`: the codename of the call that was refused (none when unknown) */
function failedPart(e: unknown, permission?: string): AkPart {
  if (e instanceof AkUpstreamError) {
    switch (e.failure.cls) {
      case 'permission': return { state: 'failed', code: 'permission', ...(permission ? { permission } : {}) };
      case 'token_invalid': return { state: 'failed', code: 'token_invalid' };
      case 'not_found': return { state: 'failed', code: 'not_found' };
      case 'network': case 'timeout': return { state: 'failed', code: 'unreachable' };
      default: return { state: 'failed', code: 'error' };
    }
  }
  if (e instanceof HttpError && e.message === 'recovery_not_configured') return { state: 'failed', code: 'no_email_stage' };
  if (e instanceof HttpError && e.message === 'authentik_unavailable') return { state: 'failed', code: 'unreachable' };
  return { state: 'failed', code: 'error' };
}

async function syncBrand(ctx: Ctx): Promise<AkPart> {
  const { title, logoUrl } = await brandParts(ctx);
  let target: { uuid: string } | null;
  try {
    target = await akBrandFor(ctx, issuerHost(ctx.cfg));
  } catch (e) {
    return failedPart(e, AK_BRANDING_PERMS.brandList);
  }
  if (!target) return { state: 'failed', code: 'not_found' };
  try {
    await akPatchBrand(ctx, target.uuid, { branding_title: title, ...(logoUrl ? { branding_logo: logoUrl } : {}) });
  } catch (e) {
    return failedPart(e, AK_BRANDING_PERMS.brandPatch);
  }
  return { state: 'done' };
}

/**
 * The stage body: the sender (Authentik's `from_address` takes a bare address only, see authentik.ts), and with `smtp` the connection
 * settings as the mail transport uses them (transport.ts): `starttls` → use_tls, `tls` → use_ssl, `none` never logs in (empty user and
 * password); a bracketed IPv6 host loses its brackets (Python's smtplib wants it bare).
 */
function stageBody(cfg: Config, smtp: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (cfg.MAIL_FROM) body.from_address = cfg.MAIL_FROM;
  if (smtp && mailConfigured(cfg)) {
    const login = cfg.MAIL_SMTP_TLS !== 'none';
    Object.assign(body, {
      use_global_settings: false,
      host: cfg.MAIL_SMTP_HOST!.replace(/^\[(.*)\]$/, '$1'),
      port: cfg.MAIL_SMTP_PORT,
      username: login ? cfg.MAIL_SMTP_USER ?? '' : '',
      password: login && cfg.MAIL_SMTP_USER ? cfg.MAIL_SMTP_PASSWORD ?? '' : '',
      use_tls: cfg.MAIL_SMTP_TLS === 'starttls',
      use_ssl: cfg.MAIL_SMTP_TLS === 'tls',
      timeout: SMTP_TIMEOUT_S,
    });
  }
  return body;
}

async function syncStage(ctx: Ctx, smtp: boolean): Promise<AkPart> {
  const body = stageBody(ctx.cfg, smtp);
  if (!Object.keys(body).length) return { state: 'skipped', code: 'nothing_to_send' };
  let pk: string;
  try {
    pk = await akRecoveryEmailStage(ctx);
  } catch (e) {
    return failedPart(e);
  }
  try {
    await akPatchEmailStage(ctx, pk, body);
  } catch (e) {
    return failedPart(e, AK_BRANDING_PERMS.stagePatch);
  }
  return { state: 'done' };
}

/** the brand first, then the stage; each part reports on its own */
export async function akSyncBranding(ctx: Ctx, o: { smtp: boolean }): Promise<{ brand: AkPart; stage: AkPart }> {
  const brand = await syncBrand(ctx);
  const stage = await syncStage(ctx, o.smtp);
  return { brand, stage };
}

/** `done`, `skipped:nothing_to_send`, `failed:permission`: the audit form of a part (codes only, never a codename or a value) */
const auditTag = (p: AkPart) => (p.state === 'done' ? 'done' : `${p.state}:${p.code}`);

const postBody = z.object({ smtp: z.boolean() }).strict();

export function akBrandingRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/admin/authentik/branding', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return akBrandingPreview(ctx);
  });

  app.post('/api/admin/authentik/branding', { ...admin, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { smtp } = postBody.parse(req.body);
    if (!configured(ctx.cfg)) return reply.code(503).send({ error: 'authentik_unavailable' });
    if (smtp && !mailConfigured(ctx.cfg)) return reply.code(400).send({ error: 'mail_not_configured' });
    if (smtp && !recentlyAuthenticated(req.session!, REAUTH_WINDOW_S)) return reply.code(401).send({ error: 'reauth_required' });
    const r = await akSyncBranding(ctx, { smtp });
    await audit(ctx, req.user!.id, 'authentik.branding', undefined, { smtp, brand: auditTag(r.brand), stage: auditTag(r.stage) });
    return r;
  });
}
