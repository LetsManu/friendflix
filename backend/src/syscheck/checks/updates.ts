// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { bounded } from '../../health.js';
import { lastRedeployFailed } from '../../redeploy.js';
import { runProbe } from '../../settings/probes.js';
import { updaterView, type UpdaterView } from '../../updater.js';
import { portainerSetup, type PortainerSetup } from '../../updates.js';
import type { CheckEnv, GroupCheck } from '../engine.js';
import { bad, line } from '../line.js';
import { CHECK_TIMEOUT_MS, type CheckLine } from '../types.js';

/**
 * Updates: whether the updater answers (updater.ts), which way "Jetzt aktualisieren" takes (the updater's own compose stack, or Portainer
 * for a stack another tool started), and whether Portainer's API takes the key and knows the stack (settings probe). The webhook is never
 * called (it would start an update). Without an updater (compose.no-updater) and without Portainer, updates are done by hand: not set up,
 * never red. Only codes and setting names leave this file, never a URL, a key or Portainer's answer.
 */
const PAGE = '/admin/update';
const DOCS_UPDATER = 'setup.md#updater';
/** the updater's status read is bounded at 5 s (updater.ts); the group leaves room for the Portainer probe */
const UPDATER_MS = 2_500;
const PROBE_SPARE_MS = 300;

function updaterLine(env: CheckEnv, v: UpdaterView | null): CheckLine {
  const id = 'updates.updater';
  if (!env.ctx.cfg.UPDATER_URL) return bad(id, 'not_set_up', 'updater_not_set', { docs: DOCS_UPDATER });
  if (!v) return line(id, 'unknown', { cause: 'check_timeout' });
  if (!v.present) return bad(id, 'warning', 'updater_down', { docs: DOCS_UPDATER, href: PAGE });
  if ('error' in v) return v.error === 'unauthorized' ? bad(id, 'problem', 'updater_secret', { docs: DOCS_UPDATER }) : bad(id, 'warning', 'updater_invalid', { docs: DOCS_UPDATER });
  return line(id, 'ok');
}

/** the Portainer way as a path: complete → ok; some settings → problem naming the missing ones; none → undefined (the caller decides) */
function portainerPath(p: PortainerSetup): CheckLine | undefined {
  const id = 'updates.path';
  if (p.configured) return line(id, 'ok', { cause: 'path_portainer' });
  if (p.missing.length) return bad(id, 'problem', 'portainer_missing', { settingKey: p.missing[0], params: { keys: p.missing.join(',') } });
  return undefined;
}

function pathLine(env: CheckEnv, v: UpdaterView | null, p: PortainerSetup): CheckLine {
  const id = 'updates.path';
  const status = v && v.present && 'status' in v ? v.status : null;
  if (status?.stack === 'own') return line(id, 'ok', { cause: 'path_compose' });
  if (status?.stack === 'foreign') return portainerPath(p) ?? bad(id, 'problem', 'portainer_not_set', { settingKey: 'PORTAINER_URL', href: PAGE });
  // no stack facts: the Portainer settings still say what they can
  const portainer = portainerPath(p);
  if (portainer) return portainer;
  if (status) return bad(id, 'warning', 'stack_unknown', { href: PAGE }); // an updater from before the stack check
  if (!env.ctx.cfg.UPDATER_URL) return bad(id, 'not_set_up', 'path_manual', { docs: DOCS_UPDATER });
  return line(id, 'unknown', { cause: 'updater_needed' });
}

async function portainerLine(env: CheckEnv, p: PortainerSetup, budgetMs: number): Promise<CheckLine> {
  const id = 'updates.portainer';
  if (!p.configured) {
    return p.missing.length
      ? line(id, 'not_set_up', { cause: 'portainer_missing', settingKey: p.missing[0], params: { keys: p.missing.join(',') } })
      : line(id, 'not_set_up', { cause: 'portainer_not_used' });
  }
  // the API way is asked (key and stack); the webhook would start an update and is never called
  const [failed, r] = await Promise.all([
    bounded(() => lastRedeployFailed(env.ctx), 1_000).then((o) => o.ok && o.v),
    p.mode === 'api' && budgetMs >= 300 ? runProbe(env.ctx, 'portainer', env.ctx.cfg, { timeoutMs: budgetMs }) : Promise.resolve(null),
  ]);
  if (p.mode === 'api' && !r) return line(id, 'unknown', { cause: 'check_timeout' });
  if (r && !r.ok) {
    if (r.code === 'unauthorized') return bad(id, 'problem', 'portainer_key_invalid', { settingKey: 'PORTAINER_API_KEY' });
    if (r.code === 'invalid' && r.detail === 'not_found') return bad(id, 'problem', 'portainer_stack_missing', { settingKey: 'PORTAINER_STACK_ID' });
    if (r.code === 'invalid') return bad(id, 'problem', 'portainer_url_invalid', { settingKey: 'PORTAINER_URL' });
    return bad(id, 'warning', 'portainer_down', { settingKey: 'PORTAINER_URL' });
  }
  // the last "Jetzt aktualisieren" through Portainer was refused (kept two days; Admin → Update has the details)
  if (failed) return bad(id, 'warning', 'redeploy_failed', { href: PAGE });
  return p.mode === 'webhook' ? line(id, 'ok', { cause: 'portainer_webhook' }) : line(id, 'ok');
}

export const updatesCheck: GroupCheck = {
  group: 'updates',
  ids: ['updates.updater', 'updates.path', 'updates.portainer'],
  timeoutMs: CHECK_TIMEOUT_MS,
  async run(env) {
    const p = portainerSetup(env.ctx);
    // the updater and the Portainer probe are independent: both run at once, each well within the group's limit
    const [u, portainer] = await Promise.all([
      env.ctx.cfg.UPDATER_URL ? bounded(() => updaterView(env.ctx), UPDATER_MS) : Promise.resolve(null),
      portainerLine(env, p, env.timeoutMs - PROBE_SPARE_MS - 1_000),
    ]);
    const view = u && u.ok ? u.v : null;
    return [updaterLine(env, view), pathLine(env, view, p), portainer];
  },
};
