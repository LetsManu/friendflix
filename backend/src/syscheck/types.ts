// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingGroup } from '../settings/registry.js';

/**
 * The Systemcheck contract (docs/superpowers/specs/2026-11-14-systemcheck-design.md): one line per check, codes only. No sentence, URL,
 * host, path, exception text or upstream body ever leaves the backend; the web turns the codes into text (i18n area `syscheck`).
 * A leaf module (no runtime imports): the checks read their constants from here without importing the engine.
 */
export const CHECK_STATUSES = ['ok', 'warning', 'problem', 'not_set_up', 'unknown'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** fixed group order on the Status page */
export const CHECK_GROUPS = ['core', 'signin', 'media', 'livetv', 'updates', 'proxy'] as const;
export type CheckGroup = (typeof CHECK_GROUPS)[number];

/** The full catalogue in display order (later stages fill the livetv, updates and proxy lines; the web mirrors this list). */
export const CHECK_IDS = [
  'core.publicUrl', 'core.database', 'core.redis', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env',
  'signin.oidc', 'signin.authentik', 'signin.flows', 'signin.issuerHost', 'signin.passkeys', 'signin.mail',
  'media.server', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder',
  'livetv.container', 'livetv.encoder', 'livetv.sources', 'livetv.guides',
  'updates.updater', 'updates.path', 'updates.portainer',
  'proxy.forwardedProto', 'proxy.peer', 'proxy.websocket', 'proxy.buffering', 'proxy.upload', 'proxy.headers',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** i18n `syscheck.cause.<code>` / `syscheck.fix.<code>`: lower-case words joined by `_` (the engine drops anything else) */
export type CauseCode = string;
export type FixCode = string;

export interface CheckLine {
  id: CheckId;
  group: CheckGroup;
  status: CheckStatus;
  /** absent for a plain ok */
  cause?: CauseCode;
  fix?: FixCode;
  /** a settings registry key; the web builds the link */
  settingKey?: string;
  /** the registry group of settingKey ('livetv' → the Live-TV settings tab) */
  settingGroup?: SettingGroup;
  /** settingKey is set in the environment: the fix adds "steht in der .env" */
  locked?: true;
  /** an app-internal page when the fix is not a setting ('/admin/status#login', '/admin/livetv') */
  href?: string;
  /** a file under docs/ with an optional heading anchor, e.g. 'setup.md#6-nginx-proxy-manager-portal-proxy-host' */
  docs?: string;
  /** numbers, fixed codes or setting names only (engine.ts safeParams) */
  params?: Record<string, number | string>;
  ms?: number;
  runs: 'server' | 'browser';
}

export interface SystemcheckResult { at: string; lines: CheckLine[]; counts: Record<CheckStatus, number> }

/** the default limit of one group check, and the sign-in group's (its Authentik reads are sequential) */
export const CHECK_TIMEOUT_MS = 4_000;
export const SIGNIN_TIMEOUT_MS = 8_000;
/**
 * how long a run waits for the health snapshot (its probes are bounded at 3 s): a check that misses it reads what it can without
 * (core asks the database and Redis directly), so one stalled input never blanks every group
 */
export const SNAPSHOT_TIMEOUT_MS = 3_300;
