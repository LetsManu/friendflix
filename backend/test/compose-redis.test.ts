// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Redis holds the sign-in sessions (`sess:<sid>`, cookie ff_sid), TV pairings and the Portainer redeploy record. It must keep them
 * across a restart of its container and a reboot of the host: append-only file on a named volume, while the container itself
 * stays locked down (read-only root, no capabilities, the image's redis user). Every compose file that defines redis is checked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, ROOT), 'utf8');
/** every compose file of the repository root (compose.yaml, compose.prod.yaml and each overlay): a new one is checked without a list */
const COMPOSE = readdirSync(ROOT).filter((f) => /^compose(\.[a-z0-9-]+)?\.yaml$/.test(f)).sort();
/** the two that define the whole stack (and so redis); every other one is an overlay */
const STACKS = ['compose.prod.yaml', 'compose.yaml'];

/** the lines of one top-level service block (`  name:` up to the next service or top-level key) */
function service(src: string, name: string): string[] {
  const lines = src.split('\n');
  const at = lines.indexOf(`  ${name}:`);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break;
    out.push(l);
  }
  return out;
}
/** the names under the top-level `volumes:` key */
function topVolumes(src: string): string[] {
  const lines = src.split('\n');
  const at = lines.indexOf('volumes:');
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l)) break;
    const m = /^ {2}([a-z0-9-]+):/.exec(l);
    if (m) out.push(m[1]!);
  }
  return out;
}

describe.each(STACKS)('%s redis', (file) => {
  const src = read(file);
  const redis = service(src, 'redis');
  const block = redis.join('\n');
  const command = (/^ {4}command: (\[.*\])$/m.exec(block)?.[1] ?? '[]');
  const args = JSON.parse(command) as string[];
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

  it('is defined', () => { expect(redis.length).toBeGreaterThan(0); });

  it('persists: append-only file, synced every second, in /data', () => {
    expect(opt('--appendonly')).toBe('yes');
    expect(opt('--appendfsync')).toBe('everysec');
    expect(opt('--dir')).toBe('/data');
    // the password still comes from the generated config file, never from the command line
    expect(args.slice(0, 2)).toEqual(['redis-server', '/run/friendflix/redis.conf']);
    expect(args).not.toContain('--requirepass');
  });

  it('keeps /data on the named volume redis-data (declared at the top level)', () => {
    expect(block).toMatch(/^ {4}volumes: \[.*\bredis-data:\/data\b.*\]$/m);
    expect(block).toMatch(/bootstrap:\/run\/friendflix:ro/);
    expect(topVolumes(src)).toContain('redis-data');
  });

  it('stays locked down: read-only root, no capabilities, the image\'s redis user, no new privileges', () => {
    expect(block).toMatch(/^ {4}read_only: true$/m);
    expect(block).toMatch(/^ {4}cap_drop: \[ALL\]$/m);
    expect(block).toMatch(/^ {4}user: "999:999"$/m);
    expect(block).toMatch(/no-new-privileges:true/);
    expect(block).not.toMatch(/docker\.sock/);
  });
});

describe('compose overlays', () => {
  it('finds the compose files of the repository (both stacks and the overlays)', () => {
    for (const f of STACKS) expect(COMPOSE).toContain(f);
    expect(COMPOSE.length).toBeGreaterThan(STACKS.length);
  });

  it.each(COMPOSE.filter((f) => !STACKS.includes(f)))('%s does not define or override redis (it would bypass the persistence checks above)', (f) => {
    expect(service(read(f), 'redis')).toEqual([]);
  });
});
