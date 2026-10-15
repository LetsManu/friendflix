// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '../config.js';
import type { Ctx } from '../ctx.js';
import { readMeta } from '../settings/repo.js';
import { SETTINGS } from '../settings/registry.js';
import type { SettingsStore } from '../settings/store.js';

/**
 * Setup mode (spec Part E1): until settings_meta.setup_completed_at is set, the app answers 503 setup_required (app.ts) and the
 * background jobs do nothing. The answer is cached per settings store and re-read once the store's rev moves: a completion bumps the
 * rev (updateMeta), and every instance sees the new rev through the bus or its 30 s poll, so the cache costs no query per request.
 */
interface Cached { rev: number; complete: boolean }
const cache = new WeakMap<SettingsStore, Cached>();
const pending = new WeakMap<SettingsStore, Promise<boolean>>();

export async function isSetupComplete(ctx: Pick<Ctx, 'db' | 'settings'>): Promise<boolean> {
  const rev = ctx.settings.rev();
  const c = cache.get(ctx.settings);
  if (c && c.rev === rev) return c.complete;
  // one read per store at a time (a burst of requests after a rev change shares it)
  let p = pending.get(ctx.settings);
  if (!p) {
    p = readMeta(ctx.db).then((m) => {
      const complete = m.setupCompletedAt !== null;
      cache.set(ctx.settings, { rev, complete });
      return complete;
    }).finally(() => pending.delete(ctx.settings));
    pending.set(ctx.settings, p);
  }
  return p;
}

const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';

/** The run-required settings (registry `runRequired`) that cfg lacks; [] once the app can run. */
export function missingRunRequired(cfg: Config): string[] {
  const c = cfg as Record<string, unknown>;
  return SETTINGS.filter((d) => (typeof d.runRequired === 'function' ? d.runRequired(cfg) : d.runRequired) && !isSet(c[d.key])).map((d) => d.key);
}

/**
 * Whether background jobs may run: setup complete and every run-required setting present. Synchronous (every tick asks), so it reads the
 * cached completion; a cold or outdated cache answers with the last known state and refreshes in the background (a cold one says no).
 */
export function isOperational(ctx: Pick<Ctx, 'db' | 'settings' | 'cfg'>): boolean {
  const c = cache.get(ctx.settings);
  if (!c || c.rev !== ctx.settings.rev()) void isSetupComplete(ctx).catch(() => undefined);
  return Boolean(c?.complete) && missingRunRequired(ctx.cfg).length === 0;
}
