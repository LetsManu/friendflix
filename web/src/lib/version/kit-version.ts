// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SvelteKit's `version.name` (`$app/env` version: service worker cache name, telemetry release, `_app/version.json`).
 * SvelteKit defaults it to `Date.now()`, which makes every build differ. For reproducible images it is derived from the
 * build inputs instead: the web image's image commit (FF_IMAGE_COMMIT build arg: the newest commit that changed the web
 * image's inputs, so the service worker cache only turns over when web changed), else SOURCE_DATE_EPOCH (its commit time),
 * else the clock (plain local `vite build` / `vite dev` without either). `dev` is the Dockerfile's local default, not a commit.
 */
export function kitVersionName(env: Record<string, string | undefined>, now: () => number = Date.now): string {
  const commit = env.FF_IMAGE_COMMIT?.trim();
  if (commit && commit !== 'dev') return commit;
  const epoch = env.SOURCE_DATE_EPOCH?.trim();
  if (epoch && /^\d+$/.test(epoch)) return epoch;
  return now().toString();
}
