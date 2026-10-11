import type { Ctx } from './ctx.js';

export interface Notice {
  /** null = broadcast to everyone */
  userId: string | null;
  kind: string;
  title: string;
  body?: string;
  link?: string;
  /** notifications with the same dedupe key are only created once */
  dedupe?: string;
  /** also push to ntfy / Discord */
  external?: boolean;
  /** also push to the recipient's own ntfy topic (never to the global ntfy / Discord) */
  personal?: boolean;
}

export async function notify(ctx: Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>, n: Notice): Promise<boolean> {
  const r = await ctx.db.query(
    'insert into notifications(user_id, kind, title, body, link, dedupe) values ($1,$2,$3,$4,$5,$6) on conflict (dedupe) do nothing returning id',
    [n.userId, n.kind, n.title, n.body ?? null, n.link ?? null, n.dedupe ?? null],
  );
  if (!r.rowCount) return false;
  if (n.external) await pushExternal(ctx, n).catch(() => undefined);
  if (n.personal && n.userId) await pushPersonal(ctx, n.userId, n).catch(() => undefined);
  return true;
}

/** Base URL of the ntfy server for personal topics: NTFY_BASE_URL, else the origin of NTFY_URL; null = not configured. */
export function ntfyBase(cfg: Pick<Ctx['cfg'], 'NTFY_BASE_URL' | 'NTFY_URL'>): string | null {
  try {
    if (cfg.NTFY_BASE_URL) return new URL(cfg.NTFY_BASE_URL).toString().replace(/\/+$/, '');
    if (cfg.NTFY_URL) return new URL(cfg.NTFY_URL).origin;
  } catch { /* invalid URL -> off */ }
  return null;
}

/** Posts to the user's own ntfy topic (user_prefs.ntfyTopic) on the configured ntfy server only. Never Discord, never the global topic. */
export async function pushPersonal(ctx: Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>, userId: string, n: Pick<Notice, 'title' | 'body' | 'link'>): Promise<boolean> {
  const base = ntfyBase(ctx.cfg);
  if (!base) return false;
  const r = await ctx.db.query<{ topic: string | null }>("select data->>'ntfyTopic' as topic from user_prefs where user_id=$1", [userId]);
  const topic = r.rows[0]?.topic;
  if (!topic || !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return false;
  const click = n.link ? new URL(n.link, ctx.cfg.PUBLIC_URL).toString() : undefined;
  const res = await ctx.fetchImpl(new URL(encodeURIComponent(topic), `${base}/`).toString(), {
    method: 'POST',
    headers: { Title: encodeURIComponent(n.title).slice(0, 200), ...(click ? { Click: click } : {}) },
    body: n.body ?? n.title,
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}

/** ntfy: plain POST with Title header. Discord: webhook JSON. Failures never break the caller. */
export async function pushExternal(ctx: Pick<Ctx, 'cfg' | 'fetchImpl'>, n: Pick<Notice, 'title' | 'body' | 'link'>) {
  const text = n.body ? `${n.title}\n${n.body}` : n.title;
  const jobs: Promise<unknown>[] = [];
  if (ctx.cfg.NTFY_URL) {
    jobs.push(ctx.fetchImpl(ctx.cfg.NTFY_URL, {
      method: 'POST',
      headers: { Title: encodeURIComponent(n.title).slice(0, 200), ...(n.link ? { Click: n.link } : {}) },
      body: n.body ?? n.title,
      signal: AbortSignal.timeout(8000),
    }));
  }
  if (ctx.cfg.DISCORD_WEBHOOK_URL) {
    jobs.push(ctx.fetchImpl(ctx.cfg.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8000),
    }));
  }
  await Promise.allSettled(jobs);
}
