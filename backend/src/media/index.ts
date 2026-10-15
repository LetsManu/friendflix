// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import { JellyfinClient, mediaBrowserHeader } from '../jellyfin/client.js';
import { JellyfinService } from '../jellyfin/service.js';
import type { KV } from '../kv.js';
import type { SettingDef } from '../settings/registry.js';
import type { MediaServer } from './types.js';

/**
 * The one place that knows the implementations. A fork adds its kind to MEDIA_SERVERS, its fields to MEDIA_FIELDS, its settings to
 * mediaSettings() and a factory below; config.ts (MEDIA_SERVER, the fields), the settings registry and server.ts pick them up from here.
 */
export const MEDIA_SERVERS = ['jellyfin'] as const;
export type MediaServerKind = (typeof MEDIA_SERVERS)[number];

/**
 * The config fields of every media server kind (config.ts spreads them into its schema). They live here, not in config.ts, so a fork adds
 * its fields, settings and factory in this one file; config.ts imports this module, so nothing here may read config.ts at load time.
 */
export const MEDIA_FIELDS = {
  JELLYFIN_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()), // compose passes '' when unset
  JELLYFIN_ADMIN_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
};

/** Registry entries of the media server settings (Admin -> Settings "media", wizard step 3); required once setup is complete for their kind. */
export function mediaSettings(): SettingDef[] {
  const jellyfin = (c: Config) => c.MEDIA_SERVER === 'jellyfin';
  return [
    { key: 'JELLYFIN_URL', kind: 'url', group: 'media', schema: MEDIA_FIELDS.JELLYFIN_URL, apply: 'live', probe: 'media', runRequired: jellyfin },
    { key: 'JELLYFIN_ADMIN_API_KEY', kind: 'secret', group: 'media', schema: MEDIA_FIELDS.JELLYFIN_ADMIN_API_KEY, secret: true, apply: 'live', probe: 'media', runRequired: jellyfin },
  ];
}

/** Each kind's media server URL setting (the gateway's upstream, /internal/gateway-config). */
const URL_KEYS: Record<MediaServerKind, keyof Config> = { jellyfin: 'JELLYFIN_URL' };

/** The config key holding the media server URL of cfg's kind: the one place that knows the key name. */
export function mediaUrlKey(cfg: Config): string {
  return URL_KEYS[cfg.MEDIA_SERVER];
}

/** The request of the media settings probe: answers 2xx only for an admin-level key, 401/403 otherwise. */
export interface MediaProbeRequest { base: string; path: string; headers: Record<string, string> }

const probeRequests: Record<MediaServerKind, (cfg: Config) => MediaProbeRequest | undefined> = {
  // GET /Auth/Keys lists the API keys: only an administrator's key may
  jellyfin: (c) => (c.JELLYFIN_URL && c.JELLYFIN_ADMIN_API_KEY
    ? { base: c.JELLYFIN_URL, path: '/Auth/Keys', headers: { Authorization: mediaBrowserHeader({ deviceId: 'portal-probe', token: c.JELLYFIN_ADMIN_API_KEY }) } }
    : undefined),
};

/** The probe request for cfg's kind; undefined while its URL or key is missing (Task 12 moves this into the media setup provider). */
export function mediaProbeRequest(cfg: Config): MediaProbeRequest | undefined {
  return probeRequests[cfg.MEDIA_SERVER](cfg);
}

/**
 * What a factory gets. `db` is the backend's shared Postgres pool: implementations that keep state (an id map, sync cursors …) use it
 * instead of opening a pool of their own. Jellyfin ignores it.
 */
export interface MediaDeps { cfg: Config; kv: KV; db: pg.Pool; encKey: Buffer; fetchImpl?: typeof fetch }

const factories: Record<MediaServerKind, (d: MediaDeps) => MediaServer> = {
  jellyfin: (d) => new JellyfinService(new JellyfinClient(d.cfg.JELLYFIN_URL!, d.cfg.JELLYFIN_ADMIN_API_KEY!, d.fetchImpl), d.kv, d.encKey),
};

export function createMediaServer(d: MediaDeps): MediaServer {
  const make = factories[d.cfg.MEDIA_SERVER];
  if (!make) throw new Error(`unknown MEDIA_SERVER ${String(d.cfg.MEDIA_SERVER)}`);
  return make(d);
}

/** Settings a given server kind cannot work with (checked at startup); [] = fine. */
export function mediaConfigProblems(cfg: Config): string[] {
  void cfg; // Jellyfin supports every setting
  return [];
}
