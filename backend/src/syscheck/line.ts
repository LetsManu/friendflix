// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { settingDef } from '../settings/registry.js';
import { CHECK_STATUSES, type CheckGroup, type CheckId, type CheckLine, type CheckStatus } from './types.js';

/**
 * Building and cleaning check lines (re-exported by engine.ts). Kept apart from the engine so the checks import it without an import cycle
 * (the engine imports the checks). Everything a line carries is checked against a fixed form here: anything else is dropped, never passed on.
 */
const NUMBER = /^-?\d+(\.\d+)?$/;
/** a release version ('10.10.7', 'v1.5.1', '10.11.0-rc1'): three parts only, so never an IPv4 address */
const VERSION = /^v?\d{1,4}\.\d{1,4}\.\d{1,4}([-+][0-9A-Za-z]{1,20})?$/;
const CODES = /^[a-z_]{1,40}(,[a-z_]{1,40})*$/;
const SETTING_NAMES = /^[A-Z][A-Z0-9_]{1,40}(,[A-Z][A-Z0-9_]{1,40})*$/;
const PARAM_KEY = /^[a-z][a-zA-Z0-9]{0,30}$/;
/**
 * a Docker container name, only as the param `source` (media.managed: the Jellyfin a move came from), in Docker's own character set
 * (a letter or digit, then letters, digits, `_`, `.` and `-`; as mediaserver/client.ts reads it): no colon, slash or space, so never a
 * URL or a path
 */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CODE = /^[a-z][a-z0-9_]{0,59}$/;
const DOCS = /^[a-z-]+\.md(#[a-z0-9-]+)?$/;
/** an app-internal path ('/admin/status#login'); never another origin (`//host`) */
const HREF = /^\/(?!\/)[a-z0-9/-]*(\?[a-zA-Z0-9_=&-]*)?(#[a-z0-9-]+)?$/;

/**
 * Keeps only values of the allowed forms: numbers, fixed codes (lower-case words, a comma list of them for e.g. the encoder advice),
 * setting names (one or a comma list) and release versions; `source` may also be a container name (CONTAINER_NAME). A URL, a path, an
 * address, free text or a secret never matches; undefined when nothing is left.
 */
export function safeParams(p: Record<string, unknown> | undefined): CheckLine['params'] {
  if (!p) return undefined;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!PARAM_KEY.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v) && NUMBER.test(String(v))) out[k] = v;
    else if (typeof v === 'string' && (NUMBER.test(v) || CODES.test(v) || SETTING_NAMES.test(v) || VERSION.test(v))) out[k] = v;
    else if (k === 'source' && typeof v === 'string' && CONTAINER_NAME.test(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export const groupOf = (id: CheckId): CheckGroup => id.slice(0, id.indexOf('.')) as CheckGroup;

/** what a check may set on a line; params are filtered by safeParams (a value of another form, or undefined, is dropped) */
export type LineOpts = Partial<Omit<CheckLine, 'id' | 'group' | 'status' | 'runs' | 'params'>> & { params?: Record<string, unknown> };

/**
 * One server line: `group` from the id prefix, `settingGroup` from the registry; an unknown setting key, a docs value that is no
 * `<file>.md#anchor`, an href that is no app path, a cause or fix that is no code and params of another form are dropped. `locked`
 * needs the live settings and is set by the engine (cleanLine) for every line a check returns.
 */
export function line(id: CheckId, status: CheckStatus, o: LineOpts = {}): CheckLine {
  const def = o.settingKey ? settingDef(o.settingKey) : undefined;
  const params = safeParams(o.params);
  return {
    id, group: groupOf(id), status,
    ...(o.cause && CODE.test(o.cause) ? { cause: o.cause } : {}),
    ...(o.fix && CODE.test(o.fix) ? { fix: o.fix } : {}),
    ...(def ? { settingKey: def.key, settingGroup: def.group } : {}),
    ...(o.href && HREF.test(o.href) ? { href: o.href } : {}),
    ...(o.docs && DOCS.test(o.docs) ? { docs: o.docs } : {}),
    ...(params ? { params } : {}),
    ...(typeof o.ms === 'number' && Number.isFinite(o.ms) ? { ms: Math.round(o.ms) } : {}),
    runs: 'server',
  };
}

/** A line that is not ok: the fix sentence is the cause's own (i18n syscheck.fix.<cause>) unless given. */
export const bad = (id: CheckId, status: CheckStatus, cause: string, o: LineOpts = {}): CheckLine => line(id, status, { cause, fix: cause, ...o });

/** A line a check returned, rebuilt through line() (whatever else it carried is dropped) plus `locked` for a setting from the environment. */
export function cleanLine(ctx: Pick<Ctx, 'settings'>, l: CheckLine): CheckLine {
  const status = (CHECK_STATUSES as readonly string[]).includes(l.status) ? l.status : 'unknown';
  const out = line(l.id, status, l);
  let fromEnv = false;
  try {
    fromEnv = out.settingKey !== undefined && ctx.settings.sources()[out.settingKey] === 'env';
  } catch { /* no sources: not locked */ }
  if (!fromEnv) return out;
  const { runs, ...rest } = out;
  return { ...rest, locked: true, runs };
}
