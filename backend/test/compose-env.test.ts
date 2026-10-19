// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The backend's `environment:` in compose.prod.yaml and compose.yaml: a line there is what lets a value in .env reach the container
 * (and lock the setting). The "Admin -> Settings" block is generated from the settings registry; `npm run compose:env` (this file with
 * UPDATE_COMPOSE_ENV=1) rewrites it. Nothing that 1.x passed through may disappear.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_ONLY_KEYS, SETTINGS } from '../src/settings/registry.js';

const ROOT = new URL('../../', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, ROOT), 'utf8');
const START = '      # >>> Admin -> Settings';
const END = '      # <<< Admin -> Settings';

/** every registry key except the media server's own (those sit in the media block; compose.plex.yaml swaps them) */
const generatedKeys = () => SETTINGS.filter((s) => s.group !== 'media').map((s) => s.key);
const renderBlock = () => generatedKeys().map((k) => `      ${k}: \${${k}:-}`).join('\n');

/** the backend service's environment lines (KEY: value) of a compose file, comments dropped */
function backendEnv(src: string): Map<string, string> {
  const lines = src.split('\n');
  const at = lines.indexOf('  backend:');
  const env = lines.indexOf('    environment:', at);
  const out = new Map<string, string>();
  for (const l of lines.slice(env + 1)) {
    if (!/^ {6}/.test(l)) break;
    const m = /^ {6}([A-Z0-9_]+): (.*?)(?: #.*)?$/.exec(l);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** what compose.prod.yaml passed to the backend in 1.1 (names): every one must still reach the container */
const PASSED_IN_1_1 = ['PUBLIC_URL', 'APP_ENC_KEY', 'INTERNAL_SECRET', 'WEBHOOK_SECRET', 'ADMIN_GROUP', 'SESSION_IDLE_SECONDS', 'SESSION_TTL_SECONDS',
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'MEDIA_SERVER', 'JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY', 'OIDC_ALLOW_INSECURE', 'REQUESTS_URL',
  'REQUESTS_API_KEY', 'NTFY_URL', 'DISCORD_WEBHOOK_URL', 'NTFY_BASE_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'TZ', 'DIGEST_DAY',
  'DIGEST_HOUR', 'METRICS_TOKEN', 'AUTHENTIK_URL', 'AUTHENTIK_API_TOKEN', 'AUTHENTIK_ENROLL_FLOW', 'AUTHENTIK_RECOVERY_FLOW', 'AUTHENTIK_TOTP_SETUP_FLOW',
  'UPDATE_REPO', 'GITHUB_TOKEN', 'PORTAINER_WEBHOOK_URL', 'PORTAINER_URL', 'PORTAINER_API_KEY', 'PORTAINER_STACK_ID', 'PORTAINER_ENDPOINT_ID',
  'PLAYBACK_CHECK_HOUR', 'PREVIEW_WARM', 'RECO_W_GENRES', 'RECO_W_TAGS', 'RECO_W_STUDIOS', 'RECO_W_PEOPLE', 'RECO_W_TEXT', 'RECO_W_NUMERIC',
  'RECO_W_COLLECTION', 'RECO_ENGINE', 'RECO_HALF_LIFE_DAYS', 'RECO_COEFFS', 'RECO_EXPLORE', 'BACKGROUND_JOBS', 'API_COMPRESSION', 'GATEWAY_URL',
  'UPDATER_URL', 'HEALTH_DISK_WARN_PCT', 'HEALTH_DISK_CRIT_PCT', 'HEALTH_DB_WARN_GB', 'CAST_ENABLED', 'POSTPLAY_ENABLED', 'DOWNLOADS_ENABLED',
  'DIRECT_PLAY_REQUIRES_DOWNLOAD', 'DOWNLOAD_DIR', 'DOWNLOAD_CACHE_MAX_GB', 'DOWNLOAD_PREP_CONCURRENCY', 'DOWNLOAD_CREATE_PER_HOUR',
  'DOWNLOAD_MIN_FREE_GB', 'DOWNLOAD_PAUSE_STREAMS', 'DOWNLOAD_FILE_TTL_HOURS', 'DOWNLOAD_OFFLINE_GRACE_DAYS'];
/** env-only keys that are fixed inside the image or not meant for .env (compose never passed them) */
const NOT_PASSED = ['PORT', 'PREVIEW_DIR', 'ROLE_TEMPLATES'];

describe.each(['compose.prod.yaml', 'compose.yaml'])('%s backend environment', (file) => {
  it('the generated Admin -> Settings block matches the settings registry', () => {
    const src = read(file);
    const a = src.indexOf(START), b = src.indexOf(END);
    expect(a, 'start marker').toBeGreaterThan(0);
    expect(b, 'end marker').toBeGreaterThan(a);
    const body = src.slice(src.indexOf('\n', src.indexOf('\n', a) + 1) + 1, b).replace(/\n$/, '');
    if (process.env.UPDATE_COMPOSE_ENV === '1' && body !== renderBlock()) {
      writeFileSync(new URL(file, ROOT), src.slice(0, src.indexOf('\n', src.indexOf('\n', a) + 1) + 1) + renderBlock() + '\n' + src.slice(b));
      return;
    }
    expect(body, `out of date: run npm run compose:env`).toBe(renderBlock());
  });

  it('passes every setting, every env-only key and everything 1.x passed; the removed names carry no value', () => {
    const env = backendEnv(read(file));
    for (const s of SETTINGS.filter((d) => d.group !== 'media' || d.key.startsWith('JELLYFIN_'))) expect(env.has(s.key), s.key).toBe(true);
    for (const k of ENV_ONLY_KEYS.filter((x) => !NOT_PASSED.includes(x) && !(file === 'compose.yaml' && x === 'UPDATER_URL'))) expect(env.has(k), k).toBe(true);
    for (const k of PASSED_IN_1_1.filter((x) => !(file === 'compose.yaml' && x === 'UPDATER_URL'))) expect(env.has(k), k).toBe(true);
    for (const k of NOT_PASSED) expect(env.has(k), k).toBe(false);
    // SEERR_*: only a marker, never the value (the backend warns that the old names are ignored)
    expect(env.get('SEERR_URL')).toBe('${SEERR_URL:+set}');
    expect(env.get('SEERR_API_KEY')).toBe('${SEERR_API_KEY:+set}');
    // generated lines only pass a value through; a default here would look like a value from .env and lock the setting
    for (const k of generatedKeys()) expect(env.get(k), k).toBe(`\${${k}:-}`);
  });
});

describe('compose.plex.yaml', () => {
  it('passes the Plex keys of the registry to the backend and leaves the updater alone (it works for compose.yaml too)', () => {
    const src = read('compose.plex.yaml');
    const env = backendEnv(src);
    for (const s of SETTINGS.filter((d) => d.key.startsWith('PLEX_'))) expect(env.has(s.key), s.key).toBe(true);
    expect(env.get('MEDIA_SERVER')).toBe('plex');
    // a profile here would switch the updater off for every Plex stack; an updater entry would break compose.yaml + this file. The
    // updater takes the stack's own files (docker.ts refreshFiles) and refuses a list that would change the media server.
    expect(src).not.toMatch(/^\s*profiles:/m);
    expect(src).not.toMatch(/^ {2}updater:/m);
  });
});

describe('updater default', () => {
  it('compose.prod.yaml starts the updater without a profile; compose.no-updater.yaml moves it and the socket proxy into one', () => {
    const prod = read('compose.prod.yaml');
    for (const svc of ['docker-proxy', 'updater']) {
      const block = prod.slice(prod.indexOf(`\n  ${svc}:\n`) + 1).split(/\n {2}[a-z]/)[0]!;
      expect(block, svc).not.toMatch(/profiles:/);
    }
    // only the socket proxy mounts the Docker socket
    const services = prod.split(/\n {2}(?=[a-z-]+:\n)/).filter((b) => b.includes('docker.sock'));
    expect(services.map((b) => b.split(':')[0])).toEqual(['docker-proxy']);
    expect(read('compose.no-updater.yaml')).toMatch(/docker-proxy:\n {4}profiles: \[updater\]\n {2}updater:\n {4}profiles: \[updater\]/);
  });
});
