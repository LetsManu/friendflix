import type { Ctx } from './ctx.js';

/**
 * UI languages of FriendFlix (codes as used by the web app, see web/src/lib/i18n and docs/i18n.md).
 * German is the source language and the fallback when nothing is configured.
 */
export const LANGUAGES = ['de', 'en', 'fr', 'es', 'it', 'tr', 'pl'] as const;
export type Language = (typeof LANGUAGES)[number];
export const FALLBACK_LANGUAGE: Language = 'de';
/** app_settings key of the instance default language (value: a JSON string, e.g. "de") */
export const DEFAULT_LANGUAGE_KEY = 'default_language';

export const isLanguage = (v: unknown): v is Language => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);

/** Instance default chosen by an admin, or null when none was stored yet (the admin is asked on the first visit). */
export async function instanceLanguage(ctx: Pick<Ctx, 'db'>): Promise<Language | null> {
  const r = await ctx.db.query<{ value: unknown }>('select value from app_settings where key=$1', [DEFAULT_LANGUAGE_KEY]);
  const v = r.rows[0]?.value;
  return isLanguage(v) ? v : null;
}

export async function setInstanceLanguage(ctx: Pick<Ctx, 'db'>, lang: Language): Promise<void> {
  await ctx.db.query(
    'insert into app_settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()',
    [DEFAULT_LANGUAGE_KEY, JSON.stringify(lang)],
  );
}

/** Language stored for a profile (per-profile prefs `language`), or null when the profile never chose one. */
export async function profileLanguage(ctx: Pick<Ctx, 'db'>, profileId: string | null | undefined): Promise<Language | null> {
  if (!profileId) return null;
  const r = await ctx.db.query<{ l: string | null }>("select data->>'language' l from profile_prefs where profile_id=$1", [profileId]);
  const v = r.rows[0]?.l;
  return isLanguage(v) ? v : null;
}

/** Effective UI language of a profile: its own choice → instance default → German. */
export async function effectiveLanguage(ctx: Pick<Ctx, 'db'>, profileId: string | null | undefined): Promise<Language> {
  return (await profileLanguage(ctx, profileId)) ?? (await instanceLanguage(ctx)) ?? FALLBACK_LANGUAGE;
}

/**
 * Best supported language from an Accept-Language header ("en-US,en;q=0.9,de;q=0.8"), or null.
 * Only used as a suggestion for the first-login language picker; the server never switches languages on its own.
 */
export function languageFromAcceptLanguage(header: string | string[] | undefined): Language | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return null;
  const tags = raw.split(',').slice(0, 20).map((part, i) => {
    const [tag = '', ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    return { base: tag.trim().toLowerCase().split('-')[0] ?? '', q: Number.isFinite(weight) ? weight : 0, i };
  }).filter((x) => x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  return tags.map((x) => x.base).find(isLanguage) ?? null;
}
