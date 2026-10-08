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
}

export async function notify(ctx: Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>, n: Notice): Promise<boolean> {
  const r = await ctx.db.query(
    'insert into notifications(user_id, kind, title, body, link, dedupe) values ($1,$2,$3,$4,$5,$6) on conflict (dedupe) do nothing returning id',
    [n.userId, n.kind, n.title, n.body ?? null, n.link ?? null, n.dedupe ?? null],
  );
  if (!r.rowCount) return false;
  if (n.external) await pushExternal(ctx, n).catch(() => undefined);
  return true;
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
