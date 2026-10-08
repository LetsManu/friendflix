import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Reads VAR, or the file referenced by VAR_FILE (Docker secrets). */
function withFileSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  // Only known settings: unrelated *_FILE variables of the host environment must never be read.
  for (const key of Object.keys(schema.shape)) {
    const path = env[`${key}_FILE`];
    if (path) out[key] = readFileSync(path, 'utf8').trim();
  }
  return out;
}

const opt = z.string().optional().transform((v) => (v ? v : undefined));

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 3600),
  /** base64 of 32 random bytes: encrypts Jellyfin passwords/tokens at rest. */
  APP_ENC_KEY: z.string().min(43),
  /** Shared secret between backend and gateway (never reaches browsers). */
  INTERNAL_SECRET: z.string().min(16),
  /** Shared secret for Jellyfin/Seerr webhooks. */
  WEBHOOK_SECRET: z.string().min(16),
  ADMIN_GROUP: z.string().default('friendflix-admins'),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  JELLYFIN_URL: z.string().url(),
  JELLYFIN_ADMIN_API_KEY: z.string().min(1),
  SEERR_URL: z.string().url(),
  SEERR_API_KEY: z.string().min(1),
  NTFY_URL: opt, // e.g. https://ntfy.example.com/friendflix
  DISCORD_WEBHOOK_URL: opt,
  METRICS_TOKEN: opt,
  AUTHENTIK_URL: opt,
  AUTHENTIK_API_TOKEN: opt,
  AUTHENTIK_ENROLL_FLOW: opt,
  /** JSON overriding role templates, see roles.ts */
  ROLE_TEMPLATES: opt,
  /** DEV ONLY: allow an http:// OIDC issuer (openid-client requires https otherwise). */
  OIDC_ALLOW_INSECURE: z.enum(['true', 'false']).default('false'),
  BACKGROUND_JOBS: z.enum(['true', 'false']).default('true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(withFileSecrets(env));
}
