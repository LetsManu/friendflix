// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { KV } from './kv.js';
import { mediaSettings } from './media/index.js';
import type { MediaRuntime, MediaServer } from './media/types.js';
import type { OidcProvider } from './oidc.js';
import type { RoleTemplate } from './roles.js';
import type { SeerrClient } from './seerr/client.js';
import type { SettingsStore } from './settings/store.js';

/** Everything the routes need. Built once by createLiveCtx (server.ts, test/helpers.ts makeEnv); tests may also inject fakes. */
export interface Ctx {
  /** the live settings snapshot (settings.current()): read it where it is used, never keep it across requests or ticks */
  cfg: Config;
  settings: SettingsStore;
  kv: KV;
  db: Db;
  oidc: OidcProvider;
  /** the media server (name kept from the Jellyfin-only days): see media/types.ts; rebuilt when its settings change */
  readonly jf: MediaServer;
  /** rebuilt when REQUESTS_URL / REQUESTS_API_KEY change; null while either is empty (the request service is optional, see requestsEnabled) */
  readonly seerr: SeerrClient | null;
  roles: Record<string, RoleTemplate>;
  encKey: Buffer;
  fetchImpl: typeof fetch;
}

export interface LiveCtxDeps {
  settings: SettingsStore;
  kv: KV;
  db: Db;
  encKey: Buffer;
  fetchImpl: typeof fetch;
  roles: Record<string, RoleTemplate>;
  oidc: OidcProvider;
  /** builds the media server / the request service client for a config; called again when their settings change */
  media(cfg: Config): MediaServer;
  requests(cfg: Config): SeerrClient;
  /** what an assignment to ctx.cfg does: tests install an override; omitted (production) = ctx.cfg is read-only */
  overrideCfg?(cfg: Config): void;
  log: { warn(o: object, m: string): void };
}

export interface LiveCtx {
  ctx: Ctx;
  /** starts the media server's own change feed (and that of every later rebuild) */
  startMedia(rt: MediaRuntime): Promise<void>;
  /** settles once the rebuilds triggered so far are done */
  ready(): Promise<void>;
  /** stops the media server and drops the change listeners */
  close(): Promise<void>;
}

const REQUEST_KEYS = ['REQUESTS_URL', 'REQUESTS_API_KEY'];
const OIDC_KEYS = ['PUBLIC_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ALLOW_INSECURE'];

/**
 * The context over the live settings: ctx.cfg is the store's current snapshot, ctx.jf / ctx.seerr are rebuilt when their settings change,
 * ctx.oidc is reset on a sign-in change (createLazyOidc). Listeners may overlap (a save and a bus reload), so each one reads the store's
 * current snapshot and does nothing when its keys did not change; media swaps run one at a time (old stop(), then new start()).
 */
export function createLiveCtx(d: LiveCtxDeps): LiveCtx {
  const { settings, log } = d;
  const mediaKeys = mediaSettings().map((s) => s.key);
  const sig = (keys: readonly string[]) => {
    const c = settings.current() as Record<string, unknown>;
    return JSON.stringify(keys.map((k) => c[k]));
  };

  let media = { inst: d.media(settings.current()), sig: sig(mediaKeys) };
  // no client without both keys: every caller checks for null (requestsEnabled / requestsClient)
  const buildRequests = (c: Config) => (c.REQUESTS_URL && c.REQUESTS_API_KEY ? d.requests(c) : null);
  let requests = { inst: buildRequests(settings.current()), sig: sig(REQUEST_KEYS) };
  let runtime: MediaRuntime | undefined;
  let chain: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const swapMedia = () => serial(async () => {
    const s = sig(mediaKeys);
    if (s === media.sig) return;
    let next: MediaServer;
    try {
      next = d.media(settings.current());
    } catch (err) {
      log.warn({ err }, 'media server rebuild failed; keeping the previous one');
      return;
    }
    const old = media.inst;
    media = { inst: next, sig: s };
    if (!runtime) return;
    await Promise.resolve(old.stop?.()).catch((err: unknown) => log.warn({ err }, 'stopping the replaced media server failed'));
    await Promise.resolve(next.start?.(runtime)).catch((err: unknown) => log.warn({ err }, 'starting the media server failed'));
  });

  const swapRequests = () => {
    const s = sig(REQUEST_KEYS);
    if (s !== requests.sig) requests = { inst: buildRequests(settings.current()), sig: s };
  };

  const ctx: Ctx = {
    get cfg() { return settings.current(); },
    set cfg(v: Config) {
      if (!d.overrideCfg) throw new Error('ctx.cfg is read-only; change settings with ctx.settings.save');
      d.overrideCfg(v);
    },
    settings, kv: d.kv, db: d.db, encKey: d.encKey, fetchImpl: d.fetchImpl, roles: d.roles, oidc: d.oidc,
    get jf() { return media.inst; },
    get seerr() { return requests.inst; },
  };

  const off = [
    settings.onChange(mediaKeys, swapMedia),
    settings.onChange(REQUEST_KEYS, swapRequests),
    settings.onChange(OIDC_KEYS, () => ctx.oidc.reset?.()),
  ];

  return {
    ctx,
    startMedia: (rt) => serial(async () => {
      runtime = rt;
      await media.inst.start?.(rt);
    }),
    ready: () => chain,
    async close() {
      for (const f of off) f();
      await serial(async () => {
        const was = runtime;
        runtime = undefined;
        if (was) await media.inst.stop?.();
      });
    },
  };
}
