// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the running backend build is (GET /api/version, backend/src/channel.ts): the release commit of its version or a
 * nightly build of main. The image is the same for both, so only the backend can tell (it looks the tag up on GitHub).
 * The web image does not know the version (only the backend image does): the footer and the device caps ask once per page load.
 * Until the answer the footer's version stays hidden (it keeps its width); a failed request leaves the caps at 0.0.0.
 */
import { get, writable } from 'svelte/store';

export type BuildKind = 'release' | 'nightly' | 'dev';
export type Channel = 'stable' | 'nightly';
export interface BuildInfo { sha: string; version: string; codename: string; build: BuildKind | null; channel: Channel | null; label: string }

const KINDS: readonly string[] = ['release', 'nightly', 'dev'];

/** Lenient parse of /api/version; null when it carries no build information. */
export function parseBuild(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const build = typeof r.build === 'string' && KINDS.includes(r.build) ? (r.build as BuildKind) : null;
  if (!build || typeof r.label !== 'string' || typeof r.sha !== 'string') return null;
  const channel = r.channel === 'stable' || r.channel === 'nightly' ? r.channel : null;
  return { sha: r.sha, version: typeof r.version === 'string' ? r.version : '', codename: typeof r.codename === 'string' ? r.codename : '', build, channel, label: r.label };
}

/** "1.1.0-nightly · abc1234" for a nightly build, else "1.1.0 · Arancini" as before (a dev build and an unknown one too) */
export function versionText(version: string, codename: string, b: BuildInfo | null): string {
  if (b?.build === 'nightly' && b.label) return b.label;
  return codename ? `${version} · ${codename}` : version;
}

export const buildInfo = writable<BuildInfo | null>(null);
let asked: Promise<BuildInfo | null> | null = null;
let settled = false;

/** the footer's version text; hidden (but with a placeholder's width) until /api/version answered */
export function footerVersion(b: BuildInfo | null): { visible: boolean; text: string } {
  return b ? { visible: true, text: versionText(b.version, b.codename, b) } : { visible: false, text: '0.0.0' };
}

/** asks /api/version once per page load; resolves to the stored answer, null when it failed (silent) */
export function loadBuild(fetchImpl: typeof fetch = fetch): Promise<BuildInfo | null> {
  asked ??= Promise.resolve()
    .then(() => fetchImpl('/api/version', { cache: 'no-store' }))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { const b = parseBuild(j); buildInfo.set(b); return b; })
    .catch(() => null)
    .then((b) => { settled = true; return b; });
  return asked;
}

const SEMVER = /^\d+\.\d+\.\d+/;
/** the backend's version without waiting (0.0.0 before the answer or when it failed) */
export function appVersionNow(): string {
  const v = get(buildInfo)?.version ?? '';
  return SEMVER.test(v) ? v : '0.0.0';
}
/** the backend's version for the device caps (its schema requires SemVer, so 0.0.0 when unknown) */
export async function appVersion(): Promise<string> {
  await loadBuild();
  return appVersionNow();
}

/**
 * A wait for the backend's version, bounded like the device probe's (null when it is known, failed or never asked for:
 * a request body built now carries it already). Starts the request when nothing asked yet.
 */
export function versionPending(ms = 400): Promise<void> | null {
  if (settled) return null;
  return Promise.race([loadBuild().then(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]);
}

/** tests only */
export function _resetBuild(): void { asked = null; settled = false; buildInfo.set(null); }
